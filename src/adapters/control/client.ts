import { EventEmitter } from "node:events";
import net from "node:net";
import type { DashboardSnapshot } from "../../core/dashboard/dashboard.js";
import type { queryLoopReports } from "../../core/loop/report.js";
import type { NotificationRequest } from "../../core/notifications/gateway.js";
import type { RuntimeGuardianFinding } from "../../core/runtime-guardian/findings.js";
import type { DailyTaskAuditServiceTickResult } from "../../core/tasks/daily-audit-service.js";
import type {
  ScheduledTaskRecord,
  TaskAuditSummary,
  TaskWindow,
} from "../../core/tasks/task-ledger.js";
import type { AgentKind } from "../../shared/types.js";
import {
  type ControlCallerProvenance,
  type ControlRequest,
  controlSocketCandidatePaths,
  createLineDecoder,
  encodeLine,
  type NotifyControlResponse,
  type PromptTranslateControlResponse,
  type ServerMessage,
} from "./protocol.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** Distributive Omit: `Omit<Union, K>` keeps only keys common to all variants
 * (losing `session`/`text`/…); this preserves each variant's own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

const RECONNECT_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 180_000;

function connectSocket(paths = controlSocketCandidatePaths()): Promise<net.Socket> {
  const [path, ...rest] = paths;
  if (!path) return Promise.reject(new Error("no control socket path configured"));
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(path);
    conn.setEncoding("utf8");
    conn.once("error", (err) => {
      conn.destroy();
      if (rest.length === 0) reject(err);
      else connectSocket(rest).then(resolve, reject);
    });
    conn.once("connect", () => {
      conn.removeAllListeners("error");
      resolve(conn);
    });
  });
}

/**
 * TUI-side client of the bot's control socket. Request/response is promise-based
 * (correlated by id); server-pushed events are re-emitted as EventEmitter events.
 * Auto-reconnects if the bot restarts (emitting `disconnected` / `reconnected`), so
 * a TUI left open survives a deploy.
 */
export class ControlClient extends EventEmitter {
  private conn: net.Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private decode = createLineDecoder<ServerMessage>();
  private closing = false;
  private readonly requestTimeoutMs: number;

  constructor(opts: { requestTimeoutMs?: number } = {}) {
    super();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      connectSocket()
        .then((conn) => {
          this.wire(conn);
          resolve();
        })
        .catch(reject);
    });
  }

  private wire(conn: net.Socket): void {
    this.conn = conn;
    conn.on("data", (chunk: string) => this.onData(chunk));
    conn.on("error", () => {}); // a `close` always follows; handle teardown there
    conn.on("close", () => {
      this.conn = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("disconnected"));
      }
      this.pending.clear();
      this.emit("disconnected");
      if (!this.closing) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const attempt = (): void => {
      if (this.closing) return;
      connectSocket()
        .then((conn) => {
          this.decode = createLineDecoder<ServerMessage>();
          this.wire(conn);
          this.emit("reconnected");
        })
        .catch(() => (setTimeout(attempt, RECONNECT_MS) as { unref?: () => void }).unref?.());
    };
    (setTimeout(attempt, RECONNECT_MS) as { unref?: () => void }).unref?.();
  }

  private onData(chunk: string): void {
    for (const msg of this.decode(chunk)) {
      if ("id" in msg) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error));
      } else {
        this.emit(msg.event, msg);
      }
    }
  }

  private callerProvenance(): ControlCallerProvenance {
    let cwd: string | undefined;
    try {
      cwd = process.cwd();
    } catch {
      cwd = undefined;
    }
    return {
      source: "control-client",
      pid: process.pid,
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  private req(
    payload: WithoutId<ControlRequest>,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`control request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const failWrite = (err: Error): void => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`control request write failed: ${err.message}`));
      };
      try {
        this.conn.write(
          encodeLine({ id, caller: this.callerProvenance(), ...payload } as ControlRequest),
          (err) => {
            if (err) failWrite(err);
          },
        );
      } catch (err) {
        failWrite(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  snapshot(): Promise<DashboardSnapshot> {
    return this.req({ op: "snapshot" }) as Promise<DashboardSnapshot>;
  }
  peek(session: string, lines: number): Promise<string> {
    return this.req({ op: "peek", session, lines }) as Promise<string>;
  }
  send(
    session: string,
    text: string,
    opts: { callerSession?: string } = {},
  ): Promise<{ status: string }> {
    return this.req({
      op: "send",
      session,
      text,
      ...(opts.callerSession !== undefined ? { callerSession: opts.callerSession } : {}),
    }) as Promise<{ status: string }>;
  }
  control(session: string, action: string): Promise<{ status: string }> {
    return this.req({ op: "control", session, action }) as Promise<{ status: string }>;
  }
  projects(): Promise<{ sid: string; label: string; alive: boolean; active: boolean }[]> {
    return this.req({ op: "projects" }) as Promise<
      { sid: string; label: string; alive: boolean; active: boolean }[]
    >;
  }
  open(
    sid: string,
    opts: { agent?: AgentKind } = {},
  ): Promise<{ status: string; session?: string; started?: string }> {
    return this.req({ op: "open", sid, ...opts }) as Promise<{
      status: string;
      session?: string;
      started?: string;
    }>;
  }
  /** Start (or switch to) a project by filesystem PATH — for a path the bot does
   * not yet know as a project. Parity with the chat /add_project flow. */
  openPath(
    path: string,
    opts: { agent?: AgentKind } = {},
  ): Promise<{
    status: string;
    session?: string;
    started?: string;
    error?: string;
    resolvedPath?: string;
    message?: string;
  }> {
    return this.req({ op: "openPath", path, ...opts }) as Promise<{
      status: string;
      session?: string;
      started?: string;
      error?: string;
      resolvedPath?: string;
      message?: string;
    }>;
  }
  openWorker(
    session: string,
    path: string,
    opts: { agent?: AgentKind } = {},
  ): Promise<{
    status: string;
    session?: string;
    started?: string;
    error?: string;
    resolvedPath?: string;
    message?: string;
  }> {
    return this.req({ op: "openWorker", session, path, ...opts }) as Promise<{
      status: string;
      session?: string;
      started?: string;
      error?: string;
      resolvedPath?: string;
      message?: string;
    }>;
  }
  /** Claude/Codex processes running OUTSIDE tmux that the bot could adopt. */
  orphans(): Promise<
    { pid: number; agent: "claude" | "codex"; busy: "busy" | "idle" | "unknown"; label: string }[]
  > {
    return this.req({ op: "orphans" }) as Promise<
      {
        pid: number;
        agent: "claude" | "codex";
        busy: "busy" | "idle" | "unknown";
        label: string;
      }[]
    >;
  }
  /** Adopt an orphan by PID: stop it, then resume it under a managed tmux
   * session (via its session-id). Mirrors the chat /adopt flow. */
  adopt(pid: number): Promise<{ ok: boolean; body: string; session?: string }> {
    return this.req({ op: "adopt", pid }) as Promise<{
      ok: boolean;
      body: string;
      session?: string;
    }>;
  }
  recover(): Promise<{ launched: number; shellOnly: number; alreadyAlive: number }> {
    return this.req({ op: "recover" }) as Promise<{
      launched: number;
      shellOnly: number;
      alreadyAlive: number;
    }>;
  }
  logs(session: string): Promise<string> {
    return this.req({ op: "logs", session }) as Promise<string>;
  }
  sysload(): Promise<string> {
    return this.req({ op: "sysload" }) as Promise<string>;
  }
  inputs(session: string): Promise<string[]> {
    return this.req({ op: "inputs", session }) as Promise<string[]>;
  }
  promptTranslate(arg: string): Promise<PromptTranslateControlResponse> {
    return this.req({ op: "promptTranslate", arg }) as Promise<PromptTranslateControlResponse>;
  }
  taskAudit(
    opts: { now?: number; force?: boolean } = {},
  ): Promise<DailyTaskAuditServiceTickResult> {
    return this.req(
      { op: "taskAudit", ...opts },
      { timeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS },
    ) as Promise<DailyTaskAuditServiceTickResult>;
  }
  loopReports(
    opts: { limit?: number; projectId?: string; status?: "passed" | "failed" } = {},
  ): Promise<ReturnType<typeof queryLoopReports>> {
    return this.req({ op: "loopReports", ...opts }) as Promise<ReturnType<typeof queryLoopReports>>;
  }
  dailyTaskAuditStatus(opts: { now?: number } = {}): Promise<{
    observedAt: number;
    lastFiredAt: number | null;
    summary: TaskAuditSummary;
    recentWindow: TaskWindow;
    recentRecords: ScheduledTaskRecord[];
    recentLimit: number;
    recentTotal: number;
    recentTruncated: boolean;
  }> {
    return this.req({ op: "dailyTaskAuditStatus", ...opts }) as Promise<{
      observedAt: number;
      lastFiredAt: number | null;
      summary: TaskAuditSummary;
      recentWindow: TaskWindow;
      recentRecords: ScheduledTaskRecord[];
      recentLimit: number;
      recentTotal: number;
      recentTruncated: boolean;
    }>;
  }
  runtimeGuardianFindings(
    opts: { now?: number; lookbackHours?: number; limit?: number; projectId?: string } = {},
  ): Promise<{
    observedAt: number;
    lookbackHours: number;
    findings: RuntimeGuardianFinding[];
    total: number;
    limit: number;
    truncated: boolean;
  }> {
    return this.req({ op: "runtimeGuardianFindings", ...opts }) as Promise<{
      observedAt: number;
      lookbackHours: number;
      findings: RuntimeGuardianFinding[];
      total: number;
      limit: number;
      truncated: boolean;
    }>;
  }
  notify(req: NotificationRequest): Promise<NotifyControlResponse> {
    return this.req({ op: "notify", ...req }) as Promise<NotifyControlResponse>;
  }
  async togglePromptTranslate(): Promise<PromptTranslateControlResponse> {
    const current = await this.promptTranslate("status");
    return await this.promptTranslate(
      current.status.ok && current.status.mode === "argos" ? "off" : "on zh en",
    );
  }
  autopilot(session: string, verb: string): Promise<{ status: string }> {
    return this.req({ op: "autopilot", session, verb }) as Promise<{ status: string }>;
  }
  sendAttachment(session: string, filePath: string, caption?: string): Promise<{ status: string }> {
    return this.req({
      op: "sendAttachment",
      session,
      filePath,
      ...(caption !== undefined ? { caption } : {}),
    }) as Promise<{
      status: string;
    }>;
  }

  close(): void {
    this.closing = true;
    this.conn?.end();
  }
}
