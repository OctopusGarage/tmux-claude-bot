import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { performStart } from "../../core/command/dispatch.js";
import { newMessageId } from "../../core/command/enqueue.js";
import { buildDashboard } from "../../core/dashboard/dashboard.js";
import type { HandlerDeps } from "../../core/deps.js";
import {
  defaultSystemLoadProbes,
  gatherSystemLoad,
  renderSystemLoad,
} from "../../core/infra/system-load.js";
import { queryLogs } from "../../core/logs/log-query.js";
import { formatLogsForChat, logsArgToFilter } from "../../core/logs/logs-view.js";
import { openRecentProjectBySid, recentProjectButtons } from "../../core/projects/project-ops.js";
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

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    const decode = createLineDecoder<ControlRequest>();
    const send = (msg: ServerMessage): void => {
      if (!conn.writable) return;
      conn.write(encodeLine(msg));
    };

    // Coalesce the fs-watch storm into one "refresh" nudge.
    let activityTimer: NodeJS.Timeout | undefined;
    const unsubscribe = deps.activity.onActivity(() => {
      if (activityTimer) return;
      activityTimer = setTimeout(() => {
        activityTimer = undefined;
        send({ event: "activity" });
      }, ACTIVITY_DEBOUNCE_MS);
      activityTimer.unref?.();
    });

    conn.on("data", (chunk: string) => {
      for (const req of decode(chunk)) void handleRequest(deps, req, send);
    });
    const cleanup = (): void => {
      if (activityTimer) clearTimeout(activityTimer);
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
