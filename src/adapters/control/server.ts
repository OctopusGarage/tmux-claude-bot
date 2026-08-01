import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { setAgentKind } from "../../core/agents/agentKindMap.js";
import { orphanBusyState, orphanLabel } from "../../core/agents/takeover.js";
import {
  adoptOrphan,
  composeAdoptOutcome,
  findAdoptableOrphans,
} from "../../core/agents/takeover-service.js";
import { validateAttachment } from "../../core/attachments/classify.js";
import {
  cancelActiveDelegatedTask,
  formatActiveDelegateCancel,
  formatActiveDelegateStart,
  parseDelegateRequirement,
  startActiveDelegatedTask,
} from "../../core/autopilot/delegated-task.js";
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
import {
  isLoopSupervisorSessionName,
  isLoopWorkerSessionName,
  isOperator,
} from "../../core/projects/operator.js";
import {
  createProjectFromPath,
  openRecentProjectBySid,
  recentProjectButtons,
  resolveProjectPath,
} from "../../core/projects/project-ops.js";
import { resolveReplyTarget } from "../../core/projects/session-reply-target.js";
import { getPathBySession, setPathForSession } from "../../core/projects/sessionPathMap.js";
import {
  applyPromptTranslateCommand,
  formatPromptTranslateCommandResult,
} from "../../core/read/prompt-translation.js";
import { getRecentInputs } from "../../core/read/recent-inputs.js";
import {
  prepareUserPromptDelivery,
  userPromptQueueFields,
} from "../../core/read/user-prompt-intake.js";
import { recoverProjects } from "../../core/recovery/recover.js";
import { renderPeekPane } from "../../core/session/output.js";
import {
  dispatchDailyTaskRepair,
  runDailyTaskAuditServiceTick,
} from "../../core/tasks/daily-audit-service.js";
import { appStateDir } from "../../shared/state-dir.js";
import type { AgentKind } from "../../shared/types.js";
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

function commandForAgent(deps: HandlerDeps, agent: AgentKind | undefined): string | undefined {
  if (agent === undefined) return undefined;
  return (
    deps.config.startCommands.find((command) => command.agent === agent)?.command ??
    (agent === "claude" ? deps.config.claudeStartCommand : undefined)
  );
}

async function performStartForRequestedAgent(
  deps: HandlerDeps,
  sessionName: string,
  agent: AgentKind | undefined,
): Promise<"started" | "already-running"> {
  const command = commandForAgent(deps, agent);
  if (agent !== undefined && command === undefined) {
    throw new Error(`no start command is configured for agent: ${agent}`);
  }
  return await performStart(deps, sessionName, command);
}

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
  server.listen(sockPath, () => {
    try {
      chmodSync(sockPath, 0o600);
    } catch (err) {
      log.error("control socket permission hardening failed", { err });
      server.close();
      return;
    }
    log.info(`control server listening`, { data: { sock: sockPath } });
  });
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
        await enqueueControl(deps, req.session, "text", req.text, send, ok, fail, {
          origin:
            req.callerSession !== undefined &&
            isLoopSupervisorSessionName(req.callerSession, deps.config.projectSessionPrefix)
              ? "system"
              : "user",
        });
        return;
      case "control":
        await enqueueControl(deps, req.session, req.action, "", send, ok, fail);
        return;
      case "projects":
        ok(await recentProjectButtons(deps, CONTROL_SCOPE));
        return;
      case "open": {
        // Switch to / (re)create the project, then start its agent (idempotent —
        // "already-running" if it was). Covers both "switch project" and "start".
        const res = await openRecentProjectBySid(deps, CONTROL_SCOPE, req.sid);
        if (res.status === "created" || res.status === "switched") {
          const started = await performStartForRequestedAgent(deps, res.sessionName, req.agent);
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
          const started = await performStartForRequestedAgent(deps, res.sessionName, req.agent);
          ok({ status: res.status, session: res.sessionName, started });
        } else {
          ok(res);
        }
        return;
      }
      case "openWorker": {
        if (!isLoopWorkerSessionName(req.session, deps.config.projectSessionPrefix)) {
          ok({
            status: "invalid",
            error: "invalid-worker-session",
            message: `worker session must match ${deps.config.projectSessionPrefix}loop-worker-*`,
          });
          return;
        }
        const workerAllowedDirs = [
          ...deps.config.cdAllowedDirs,
          join(appStateDir(), "loop-worktrees"),
        ];
        const resolved = await resolveProjectPath(req.path, workerAllowedDirs);
        if (resolved.error !== undefined) {
          ok({ status: "invalid", error: resolved.error, resolvedPath: resolved.resolvedPath });
          return;
        }
        const mapped = getPathBySession(req.session);
        const live = await deps.bridge.hasSession(req.session);
        if (live && mapped !== null && mapped !== resolved.resolvedPath) {
          ok({
            status: "error",
            message: `worker session ${req.session} is already mapped to ${mapped}`,
          });
          return;
        }
        if (!live) await deps.bridge.createSession(req.session, resolved.resolvedPath);
        setPathForSession(req.session, resolved.resolvedPath);
        if (req.agent !== undefined) {
          setAgentKind(req.session, req.agent);
          deps.configResolver.invalidate(req.session);
        }
        const started = await performStartForRequestedAgent(deps, req.session, req.agent);
        ok({
          status: live ? "switched" : "created",
          session: req.session,
          started,
          resolvedPath: resolved.resolvedPath,
        });
        return;
      }
      case "orphans": {
        // Claude/Codex running OUTSIDE tmux that the bot could adopt.
        const orphans = await findAdoptableOrphans();
        ok(
          orphans.map((o) => ({
            pid: o.pid,
            agent: o.agent,
            busy: orphanBusyState(o),
            label: orphanLabel(o),
          })),
        );
        return;
      }
      case "adopt": {
        // Stop the orphan and resume it under a managed session — the same
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
      case "promptTranslate": {
        const status = await applyPromptTranslateCommand("control", req.arg);
        ok({ body: formatPromptTranslateCommandResult(status), status });
        return;
      }
      case "taskAudit":
        ok(
          await runDailyTaskAuditServiceTick({
            now: req.now ?? Date.now(),
            config: deps.config.taskAudit,
            notifications: deps.notifications,
            dispatchRepair: (request) => dispatchDailyTaskRepair(deps, request),
            loopConfigFile: deps.config.loopEngineering.configFile,
            force: req.force ?? false,
          }),
        );
        return;
      case "notify":
        ok(
          await deps.notifications.notify({
            title: req.title,
            ...(req.body !== undefined ? { body: req.body } : {}),
            ...(req.channel !== undefined ? { channel: req.channel } : {}),
            ...(req.level !== undefined ? { level: req.level } : {}),
            ...(req.source !== undefined ? { source: req.source } : {}),
            ...(req.session !== undefined ? { session: req.session } : {}),
            ...(req.attachments !== undefined ? { attachments: req.attachments } : {}),
            ...(req.opportunities !== undefined ? { opportunities: req.opportunities } : {}),
          }),
        );
        return;
      case "autopilot": {
        const verb = req.verb.trim();
        if (/^(?:cancel|stop|cancel-delegate|cancel_delegate)$/i.test(verb)) {
          const result = await cancelActiveDelegatedTask(deps, { session: req.session });
          ok({ status: formatActiveDelegateCancel(result) });
          return;
        }
        const delegatedRequirement =
          parseDelegateRequirement(
            verb.length === 0 || /^delegate\b/i.test(verb)
              ? verb || "delegate"
              : `delegate ${verb}`,
          ) ?? parseDelegateRequirement("delegate");
        if (delegatedRequirement === null) {
          ok({ status: "Autopilot delegate failed: could not build a delegation requirement." });
          return;
        }
        const result = await startActiveDelegatedTask(deps, {
          session: req.session,
          requirement: delegatedRequirement,
        });
        ok({ status: formatActiveDelegateStart(result) });
        return;
      }
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
async function enqueueControl(
  deps: HandlerDeps,
  session: string,
  action: string,
  text: string,
  send: (msg: ServerMessage) => void,
  ok: (data: unknown) => void,
  fail: (error: string) => void,
  opts: { origin?: "user" | "system" } = {},
): Promise<void> {
  const prepared =
    action === "text"
      ? await prepareUserPromptDelivery("control", text, "text")
      : ({ ok: true, text } as const);
  if (!prepared.ok) {
    fail(messages("telegram").promptTranslateFailed);
    return;
  }
  const verdict = deps.queue.enqueue({
    id: newMessageId(),
    ...(action === "text" && "preview" in prepared
      ? userPromptQueueFields(prepared)
      : { text: prepared.text }),
    chatId: "control",
    sessionName: session,
    action,
    origin: opts.origin ?? "user",
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
