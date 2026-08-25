import { chmodSync, existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import type { HandlerDeps } from "../../core/deps.js";
import { createLogger } from "../../shared/utils/logger.js";
import { appVersion } from "../../shared/version.js";
import { handleControlRequest, handleSendAttachment } from "./operations.js";
import {
  type ControlRequest,
  controlSocketPath,
  createLineDecoder,
  encodeLine,
  type ServerMessage,
} from "./protocol.js";

export { handleSendAttachment };

const log = createLogger("control.server");

const ACTIVITY_DEBOUNCE_MS = 300;

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

  // Per-connection send fns; removed on close.
  const clients = new Set<(m: ServerMessage) => void>();

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    const decode = createLineDecoder<ControlRequest>();
    const send = (msg: ServerMessage): void => {
      if (!conn.writable) return;
      try {
        conn.write(encodeLine(msg), (err) => {
          if (!err) return;
          log.warn("control response write failed", { err });
          conn.destroy();
        });
      } catch (err) {
        log.warn("control response write failed", { err });
        conn.destroy();
      }
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
      for (const req of decode(chunk)) void handleControlRequest(deps, req, send);
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
  server.listen(sockPath, () => {
    if (!hardenControlSocket(sockPath, server)) return;
    log.info(`control server listening`, { data: { sock: sockPath } });
  });
  return server;
}

export function hardenControlSocket(sockPath: string, server: Pick<net.Server, "close">): boolean {
  try {
    chmodSync(sockPath, 0o600);
    return true;
  } catch (err) {
    log.error("control socket permission hardening failed", { err });
    server.close();
    return false;
  }
}
