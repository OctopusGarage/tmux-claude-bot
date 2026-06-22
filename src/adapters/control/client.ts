import { EventEmitter } from "node:events";
import net from "node:net";
import type { AutopilotView } from "../../core/autopilot/autopilot-view.js";
import type { DashboardSnapshot } from "../../core/dashboard/dashboard.js";
import {
  type ControlRequest,
  controlSocketPath,
  createLineDecoder,
  encodeLine,
  type ServerMessage,
} from "./protocol.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Distributive Omit: `Omit<Union, K>` keeps only keys common to all variants
 * (losing `session`/`text`/…); this preserves each variant's own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

const RECONNECT_MS = 1000;

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

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(controlSocketPath());
      conn.setEncoding("utf8");
      conn.once("error", reject); // pre-connect failure → bot not running
      conn.once("connect", () => {
        conn.removeListener("error", reject);
        this.wire(conn);
        resolve();
      });
    });
  }

  private wire(conn: net.Socket): void {
    this.conn = conn;
    conn.on("data", (chunk: string) => this.onData(chunk));
    conn.on("error", () => {}); // a `close` always follows; handle teardown there
    conn.on("close", () => {
      this.conn = null;
      for (const p of this.pending.values()) p.reject(new Error("disconnected"));
      this.pending.clear();
      this.emit("disconnected");
      if (!this.closing) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const attempt = (): void => {
      if (this.closing) return;
      const conn = net.createConnection(controlSocketPath());
      conn.setEncoding("utf8");
      conn.once("error", () =>
        (setTimeout(attempt, RECONNECT_MS) as { unref?: () => void }).unref?.(),
      );
      conn.once("connect", () => {
        conn.removeAllListeners("error");
        this.decode = createLineDecoder<ServerMessage>();
        this.wire(conn);
        this.emit("reconnected");
      });
    };
    (setTimeout(attempt, RECONNECT_MS) as { unref?: () => void }).unref?.();
  }

  private onData(chunk: string): void {
    for (const msg of this.decode(chunk)) {
      if ("id" in msg) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error));
      } else {
        this.emit(msg.event, msg);
      }
    }
  }

  private req(payload: WithoutId<ControlRequest>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.conn.write(encodeLine({ id, ...payload } as ControlRequest));
    });
  }

  snapshot(): Promise<DashboardSnapshot> {
    return this.req({ op: "snapshot" }) as Promise<DashboardSnapshot>;
  }
  peek(session: string, lines: number): Promise<string> {
    return this.req({ op: "peek", session, lines }) as Promise<string>;
  }
  send(session: string, text: string): Promise<{ status: string }> {
    return this.req({ op: "send", session, text }) as Promise<{ status: string }>;
  }
  control(session: string, action: string): Promise<{ status: string }> {
    return this.req({ op: "control", session, action }) as Promise<{ status: string }>;
  }
  projects(): Promise<{ sid: string; label: string; alive: boolean; active: boolean }[]> {
    return this.req({ op: "projects" }) as Promise<
      { sid: string; label: string; alive: boolean; active: boolean }[]
    >;
  }
  open(sid: string): Promise<{ status: string; session?: string; started?: string }> {
    return this.req({ op: "open", sid }) as Promise<{
      status: string;
      session?: string;
      started?: string;
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
  autopilot(session: string, verb: string): Promise<{ status: string }> {
    return this.req({ op: "autopilot", session, verb }) as Promise<{ status: string }>;
  }
  autopilotView(session: string): Promise<AutopilotView> {
    return this.req({ op: "autopilotView", session }) as Promise<AutopilotView>;
  }

  close(): void {
    this.closing = true;
    this.conn?.end();
  }
}
