import { existsSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import { orphanLabel } from "../../core/agents/takeover.js";
import {
  adoptOrphan,
  composeAdoptOutcome,
  findAdoptableOrphans,
} from "../../core/agents/takeover-service.js";
import { validateAttachment } from "../../core/attachments/classify.js";
import { buildAutopilotView } from "../../core/autopilot/autopilot-view.js";
import { applyAutopilotVerb } from "../../core/autopilot/controls.js";
import { AutopilotStore } from "../../core/autopilot/state-store.js";
import { performStart } from "../../core/command/dispatch.js";
import { newMessageId } from "../../core/command/enqueue.js";
import { buildDashboard } from "../../core/dashboard/dashboard.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import {
  defaultSystemLoadProbes,
  gatherSystemLoad,
  renderSystemLoad,
} from "../../core/infra/system-load.js";
import { queryLogs } from "../../core/logs/log-query.js";
import { formatLogsForChat, logsArgToFilter } from "../../core/logs/logs-view.js";
import { isOperator } from "../../core/projects/operator.js";
import {
  createProjectFromPath,
  openRecentProjectBySid,
  recentProjectButtons,
} from "../../core/projects/project-ops.js";
import { resolveReplyTarget } from "../../core/projects/session-reply-target.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import { getRecentInputs } from "../../core/read/recent-inputs.js";
import { recoverProjects } from "../../core/recovery/recover.js";
import { renderPeekPane } from "../../core/session/output.js";
import { createLogger } from "../../shared/utils/logger.js";
import { appVersion } from "../../shared/version.js";
import {
  type ControlRequest,
  controlSocketPath,
  createLineDecoder,
  encodeLine,
  type ServerMessage,
} from "./protocol.js";

const log = createLogger("control.server");

const ACTIVITY_DEBOUNCE_MS = 300;
// Scope key for the control transport's "current project" (used only to mark the
// active project + as the open/switch scope; the TUI always acts on an explicit
// session, so this never affects routing).
const CONTROL_SCOPE = "control";

/**
 * Start the local control server: a unix-socket transport that makes the running
 * bot drivable by the terminal TUI. Like the chat adapters it funnels every
 * mutation through the ONE per-session queue (so the TUI can't race Telegram/Lark),
 * and it pushes activity/reply events so the TUI stays live. Best-effort: a socket
 * failure logs and is swallowed — it must never take the bot down.
 */
export function startControlServer(deps: HandlerDeps): net.Server {
  const sockPath = controlSocketPath();
  // No persisted-backlog handling needed: control prompts are enqueued `ephemeral`,
  // so they never reach pending.json (the TUI is an ephemeral client — a restored
  // prompt would have no one to answer).
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath); // clear a stale socket from a previous run
  } catch (err) {
    log.warn("could not remove stale control socket", { err });
  }

  // Per-connection send fns; registered once per connect, removed on close.
  // The pusher is registered ONCE (not per-connection) so it doesn't leak.
  const clients = new Set<(m: ServerMessage) => void>();
  deps.notifier.register(async (notice) => {
    if (!("session" in notice)) return;
    for (const s of clients) s({ event: "autopilot", session: notice.session, kind: notice.kind });
  });

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    const decode = createLineDecoder<ControlRequest>();
    const send = (msg: ServerMessage): void => {
      if (!conn.writable) return;
      conn.write(encodeLine(msg));
    };
    clients.add(send);

    // Coalesce the fs-watch storm into one "refresh" nudge.
    let activityTimer: NodeJS.Timeout | undefined;
    const unsubscribe = deps.activity.onActivity(() => {
      if (activityTimer) return;
      activityTimer = setTimeout(() => {
        activityTimer = undefined;
        send({ event: "activity" });
      }, ACTIVITY_DEBOUNCE_MS);
      (activityTimer as { unref?: () => void }).unref?.();
    });

    conn.on("data", (chunk: string) => {
      for (const req of decode(chunk)) void handleRequest(deps, req, send);
    });
    const cleanup = (): void => {
      if (activityTimer) clearTimeout(activityTimer);
      clients.delete(send);
      unsubscribe();
    };
    conn.on("close", cleanup);
    conn.on("error", (err) => {
      log.warn("control connection error", { err });
      cleanup();
    });

    send({ event: "hello", version: appVersion() });
  });

  server.on("error", (err) => log.error("control server error", { err }));
  server.listen(sockPath, () => log.info(`control server listening`, { data: { sock: sockPath } }));
  return server;
}

export async function handleSendAttachment(
  deps: Pick<HandlerDeps, "channelSenders">,
  req: {
    session: string;
    filePath: string;
    caption?: string;
    statInfo?: (p: string) => { size: number; isFile: boolean } | null;
  },
): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const statInfo =
    req.statInfo ??
    ((p: string) => {
      try {
        const st = statSync(p);
        return { size: st.size, isFile: st.isFile() };
      } catch {
        return null;
      }
    });
  const target = resolveReplyTarget(req.session);
  if (!target) return { ok: false, error: "no chat is bound to this session" };
  const v = validateAttachment(req.filePath, statInfo);
  if (!v.ok) return { ok: false, error: v.error };
  try {
    await deps.channelSenders.send(
      target.channel,
      target.chatId,
      req.filePath,
      v.kind,
      req.caption,
    );
    return { ok: true, status: "sent" };
  } catch (err) {
    log.warn("attachment send failed", { err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleRequest(
  deps: HandlerDeps,
  req: ControlRequest,
  send: (msg: ServerMessage) => void,
): Promise<void> {
  const ok = (data: unknown): void => send({ id: req.id, ok: true, data });
  const fail = (error: string): void => send({ id: req.id, ok: false, error });
  try {
    switch (req.op) {
      case "snapshot":
        ok(await buildDashboard(deps));
        return;
      case "peek": {
        const snapshot = await deps.bridge.capturePaneColored(req.session, req.lines);
        ok(renderPeekPane(snapshot, deps.output));
        return;
      }
      case "send":
        if (isOperator(req.session, deps.config.projectSessionPrefix)) {
          fail("cannot send to the operator session");
          return;
        }
        enqueueControl(deps, req.session, "text", req.text, send, ok, fail);
        return;
      case "control":
        enqueueControl(deps, req.session, req.action, "", send, ok, fail);
        return;
      case "projects":
        ok(await recentProjectButtons(deps, CONTROL_SCOPE));
        return;
      case "open": {
        // Switch to / (re)create the project, then start its agent (idempotent —
        // "already-running" if it was). Covers both "switch project" and "start".
        const res = await openRecentProjectBySid(deps, CONTROL_SCOPE, req.sid);
        if (res.status === "created" || res.status === "switched") {
          const started = await performStart(deps, res.sessionName);
          ok({ status: res.status, session: res.sessionName, started });
        } else {
          ok(res);
        }
        return;
      }
      case "openPath": {
        // Start (or switch to) a project by filesystem path — parity with the
        // chat /add_project flow, for a path the bot doesn't yet know. Same
        // create-then-start as `open`; invalid/error pass through for the client.
        const res = await createProjectFromPath(deps, CONTROL_SCOPE, req.path);
        if (res.status === "created" || res.status === "switched") {
          const started = await performStart(deps, res.sessionName);
          ok({ status: res.status, session: res.sessionName, started });
        } else {
          ok(res);
        }
        return;
      }
      case "orphans": {
        // Claude/Codex running OUTSIDE tmux that the bot could adopt.
        const orphans = await findAdoptableOrphans();
        ok(orphans.map((o) => ({ pid: o.pid, label: orphanLabel(o) })));
        return;
      }
      case "adopt": {
        // Stop the orphan and resume it under a managed tmux session — the same
        // takeover the chat /adopt button runs.
        const result = await adoptOrphan(req.pid, {
          bridge: deps.bridge,
          configResolver: deps.configResolver,
          projectSessionPrefix: deps.config.projectSessionPrefix,
          warmupMs: deps.config.sessionWarmupMs,
        });
        const outcome = composeAdoptOutcome(result, CONTROL_SCOPE);
        if (outcome.ok) await deps.currentProject.set(CONTROL_SCOPE, outcome.sessionName);
        ok({
          ok: outcome.ok,
          body: outcome.body,
          ...(outcome.ok ? { session: outcome.sessionName } : {}),
        });
        return;
      }
      case "recover": {
        const r = await recoverProjects(deps);
        ok({
          launched: r.launched.length,
          shellOnly: r.shellOnly.length,
          alreadyAlive: r.alreadyAlive.length,
        });
        return;
      }
      case "logs": {
        const filter = logsArgToFilter(undefined, req.session);
        ok(filter ? formatLogsForChat(queryLogs(filter), { maxChars: 3500 }) : "no session");
        return;
      }
      case "sysload":
        ok(renderSystemLoad(await gatherSystemLoad(defaultSystemLoadProbes())));
        return;
      case "inputs":
        ok(
          await getRecentInputs(
            deps,
            req.session,
            getPathBySession(req.session) ?? req.session,
            12,
          ),
        );
        return;
      case "autopilot": {
        const status = applyAutopilotVerb(
          new AutopilotStore(),
          req.session,
          req.verb,
          messages("telegram"),
          deps.config.autopilot.maxRounds,
        );
        ok({ status });
        return;
      }
      case "autopilotView":
        ok(
          buildAutopilotView(
            new AutopilotStore(),
            req.session,
            messages("telegram"),
            deps.config.autopilot.maxRounds,
          ),
        );
        return;
      case "sendAttachment": {
        const res = await handleSendAttachment(deps, {
          session: req.session,
          filePath: req.filePath,
          ...(req.caption !== undefined ? { caption: req.caption } : {}),
        });
        if (res.ok) ok({ status: res.status });
        else fail(res.error);
        return;
      }
      default:
        fail(`unknown op: ${(req as { op: string }).op}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Enqueue a prompt/control action through the bot's single queue. Acked
 * immediately; the eventual reply/notify/error arrives as an event by session. */
function enqueueControl(
  deps: HandlerDeps,
  session: string,
  action: string,
  text: string,
  send: (msg: ServerMessage) => void,
  ok: (data: unknown) => void,
  fail: (error: string) => void,
): void {
  const verdict = deps.queue.enqueue({
    id: newMessageId(),
    text,
    chatId: "control",
    sessionName: session,
    action,
    ephemeral: true,
    resolve: (output) => send({ event: "reply", session, output }),
    reject: (err) => send({ event: "error", session, error: err.message }),
    notify: (t) => send({ event: "notify", session, text: t }),
  });
  if (!verdict) {
    fail("queue full");
    return;
  }
  ok({ status: verdict }); // "queued" | "duplicate"
}
