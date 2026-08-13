import { statSync } from "node:fs";
import { validateAttachment } from "../../core/attachments/classify.js";
import {
  cancelActiveDelegatedTask,
  formatActiveDelegateCancel,
  formatActiveDelegateStart,
  parseDelegateRequirement,
  startActiveDelegatedTask,
} from "../../core/autopilot/delegated-task.js";
import { newMessageId } from "../../core/command/enqueue.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { isLoopSupervisorSessionName, isOperator } from "../../core/projects/operator.js";
import { isOperatorHomePath } from "../../core/projects/operator-home.js";
import { resolveReplyTarget } from "../../core/projects/session-reply-target.js";
import {
  prepareUserPromptDelivery,
  userPromptQueueFields,
} from "../../core/read/user-prompt-intake.js";
import {
  dispatchDailyTaskRepair,
  runDailyTaskAuditServiceTick,
} from "../../core/tasks/daily-audit-service.js";
import {
  createProjectRecoveryDelegator,
  dispatchProjectRecovery,
} from "../../core/tasks/project-recovery-dispatch.js";
import { createLogger } from "../../shared/utils/logger.js";
import { createControlDiagnosticsHandlers } from "./operations-diagnostics.js";
import { createControlObservationHandlers } from "./operations-observation.js";
import { createControlProjectSessionHandlers } from "./operations-project-sessions.js";
import type { ControlOperationHandler, ControlOperationHandlers } from "./operations-types.js";
import type { ControlRequest, ServerMessage } from "./protocol.js";

const log = createLogger("control.operations");

export const controlOperationNames = [
  "snapshot",
  "peek",
  "send",
  "control",
  "projects",
  "open",
  "openPath",
  "openWorker",
  "orphans",
  "adopt",
  "recover",
  "logs",
  "sysload",
  "inputs",
  "promptTranslate",
  "taskAudit",
  "loopReports",
  "dailyTaskAuditStatus",
  "runtimeGuardianFindings",
  "notify",
  "autopilot",
  "sendAttachment",
] as const satisfies readonly ControlRequest["op"][];

export function createControlOperationHandlers(
  deps: HandlerDeps,
  send: (msg: ServerMessage) => void,
): ControlOperationHandlers {
  return {
    ...createControlDiagnosticsHandlers(deps),
    ...createControlProjectSessionHandlers(deps),
    ...createControlObservationHandlers(deps),
    send: async (req, { ok, fail }) => {
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
    },
    control: async (req, { ok, fail }) => {
      await enqueueControl(deps, req.session, req.action, "", send, ok, fail);
    },
    taskAudit: async (req, { ok }) => {
      ok(
        await runDailyTaskAuditServiceTick({
          now: req.now ?? Date.now(),
          config: deps.config.taskAudit,
          notifications: deps.notifications,
          dispatchRepair: (request) => dispatchDailyTaskRepair(deps, request),
          dispatchProjectRecovery: (request) =>
            dispatchProjectRecovery(request, {
              projectSessionPrefix: deps.config.projectSessionPrefix,
              worktreeIsolation:
                deps.config.loopEngineering.supervisor.worktreeIsolation === "source"
                  ? "source"
                  : "isolated",
              delegate: createProjectRecoveryDelegator(deps),
            }),
          loopConfigFile: deps.config.loopEngineering.configFile,
          force: req.force ?? false,
        }),
      );
    },
    notify: async (req, { ok }) => {
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
    },
    autopilot: async (req, { ok }) => {
      const verb = req.verb.trim();
      if (/^(?:cancel|stop|cancel-delegate|cancel_delegate)$/i.test(verb)) {
        const result = await cancelActiveDelegatedTask(deps, { session: req.session });
        ok({ status: formatActiveDelegateCancel(result) });
        return;
      }
      const delegatedRequirement =
        parseDelegateRequirement(
          verb.length === 0 || /^delegate\b/i.test(verb) ? verb || "delegate" : `delegate ${verb}`,
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
    },
    sendAttachment: async (req, { ok, fail }) => {
      const res = await handleSendAttachment(deps, {
        session: req.session,
        filePath: req.filePath,
        ...(req.caption !== undefined ? { caption: req.caption } : {}),
      });
      if (res.ok) ok({ status: res.status });
      else fail(res.error);
    },
  };
}

export async function handleControlRequest(
  deps: HandlerDeps,
  req: ControlRequest,
  send: (msg: ServerMessage) => void,
  handlers: ControlOperationHandlers = createControlOperationHandlers(deps, send),
): Promise<void> {
  const ok = (data: unknown): void => send({ id: req.id, ok: true, data });
  const fail = (error: string): void => send({ id: req.id, ok: false, error });
  try {
    const handler = handlers[req.op] as ControlOperationHandler<ControlRequest> | undefined;
    if (handler === undefined) {
      fail(`unknown op: ${(req as { op: string }).op}`);
      return;
    }
    await handler(req, {
      send,
      ok,
      fail,
      ...(req.caller !== undefined ? { caller: req.caller } : {}),
      isOperatorHomeCaller: isOperatorHomePath(deps.config, req.caller?.cwd),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
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
  ok({ status: verdict });
}
