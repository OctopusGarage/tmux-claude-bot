import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { ConfigResolver } from "../agents/agent-config-resolver.js";
import { setAgentKind } from "../agents/agentKindMap.js";
import type { AgentRunner } from "../agents/runner.js";
import type { AgentKind } from "../agents/types.js";
import { newMessageId } from "../command/enqueue.js";
import type { MessageQueue } from "../command/queue.js";
import { restorePersistedChannel } from "../command/queue-restore.js";
import { appendRecentProject } from "../projects/recentProjects.js";
import {
  resolveLiveSessionName,
  sessionNameFromPath,
  setPathForSession,
} from "../projects/sessionPathMap.js";
import type {
  LoopAgentEvalInvocation,
  LoopAgentTaskInvocation,
  LoopRunCommandResult,
} from "./run.js";
import type { SupervisorDispatchRequest } from "./supervised-runner.js";
import {
  leaseLoopSupervisorWorker,
  readLoopSupervisorWorkerLeaseState,
  releaseLoopSupervisorWorker,
  writeLoopSupervisorWorkerLeaseState,
} from "./supervisor-pool.js";
import { writeLoopSupervisorWorkOrderState } from "./supervisor-state.js";
import {
  loopSupervisorControlRestore,
  restoredLoopSupervisorMessage,
  shouldDiscardRestoredLoopSupervisorMessage,
} from "./supervisor-work-restore.js";
import { type LoopWorkOrder, parseSupervisorFinalSummaryFile } from "./work-order.js";

const log = createLogger("loop.agent-queue");
const DEFAULT_WORKER_FAILURE_RETAIN_MS = 72 * 60 * 60 * 1000;
const SUPERVISOR_WORKER_CONSUMPTION_TIMEOUT_MS = 30_000;
const DEFERRED_SUPERVISOR_QUEUE_TIMEOUT_MS = 7_200_000;

type QueueDeps = {
  bridge: {
    hasSession(sessionName: string): Promise<boolean>;
    createSession?(sessionName: string, cwd?: string): Promise<boolean>;
  };
  agent?: Pick<AgentRunner, "start">;
  config: { projectSessionPrefix: string };
  configResolver?: Pick<ConfigResolver, "detectAgentKind"> &
    Partial<Pick<ConfigResolver, "invalidate">>;
  queue: Pick<MessageQueue, "cancelQueued" | "enqueue">;
};

type ControlRestoreQueueDeps = {
  queue: Pick<MessageQueue, "enqueue" | "keepPersistedCarryover" | "loadPersisted">;
};

type LoopAgentPrompt = {
  cwd: string;
  agent: AgentKind;
  prompt: string;
  projectId: string;
  contextReset?: "none" | "compact" | "clear";
};

async function resolveProjectSession(deps: QueueDeps, cwd: string): Promise<string | null> {
  const intended = sessionNameFromPath(cwd, deps.config.projectSessionPrefix);
  return resolveLiveSessionName(deps.bridge, intended);
}

async function ensureProjectSession(
  deps: QueueDeps,
  prompt: LoopAgentPrompt,
): Promise<
  { status: "ready"; sessionName: string } | { status: "failed"; result: LoopRunCommandResult }
> {
  const live = await resolveProjectSession(deps, prompt.cwd);
  if (live !== null) return { status: "ready", sessionName: live };
  if (deps.bridge.createSession === undefined || deps.agent === undefined) {
    return {
      status: "failed",
      result: {
        status: 1,
        stdout: "",
        stderr: `no live project session for loop project "${prompt.projectId}"`,
      },
    };
  }

  const sessionName = sessionNameFromPath(prompt.cwd, deps.config.projectSessionPrefix);
  try {
    log.info("starting missing loop project session", {
      session: sessionName,
      data: { projectId: prompt.projectId, cwd: prompt.cwd, agent: prompt.agent },
    });
    await deps.bridge.createSession(sessionName, prompt.cwd);
    setPathForSession(sessionName, prompt.cwd);
    await appendRecentProject(prompt.cwd, deps.config.projectSessionPrefix);
    setAgentKind(sessionName, prompt.agent);
    deps.configResolver?.invalidate?.(sessionName);
    await deps.agent.start(sessionName);
  } catch (err) {
    return {
      status: "failed",
      result: {
        status: 1,
        stdout: "",
        stderr: `failed to start loop project session "${prompt.projectId}": ${normalizeError(err).message}`,
      },
    };
  }

  const started = await resolveProjectSession(deps, prompt.cwd);
  if (started === null) {
    return {
      status: "failed",
      result: {
        status: 1,
        stdout: "",
        stderr: `failed to start loop project session "${prompt.projectId}": session is not live after start`,
      },
    };
  }
  return { status: "ready", sessionName: started };
}

async function enqueueLoopAgentPrompt(
  deps: QueueDeps,
  prompt: LoopAgentPrompt,
): Promise<LoopRunCommandResult> {
  const session = await ensureProjectSession(deps, prompt);
  if (session.status === "failed") return session.result;
  const { sessionName } = session;
  if (deps.configResolver?.detectAgentKind !== undefined) {
    const liveAgent = await deps.configResolver.detectAgentKind(sessionName);
    if (liveAgent === null) {
      return {
        status: 1,
        stdout: "",
        stderr: `no live ${prompt.agent} agent for loop project "${prompt.projectId}"`,
      };
    }
    if (liveAgent !== prompt.agent) {
      return {
        status: 1,
        stdout: "",
        stderr: `loop project "${prompt.projectId}" requires ${prompt.agent} but live session is ${liveAgent}`,
      };
    }
  }

  const resetResult = await enqueueContextResetIfNeeded(deps, sessionName, prompt.contextReset);
  if (resetResult !== null && resetResult.status !== 0) return resetResult;

  return new Promise((resolve) => {
    const verdict = deps.queue.enqueue({
      id: newMessageId(),
      text: prompt.prompt,
      chatId: "loop-engineering",
      sessionName,
      action: "text",
      channel: "control",
      origin: "system",
      promptSource: "control",
      resolve: (output) => resolve({ status: 0, stdout: output, stderr: "" }),
      reject: (err) => resolve({ status: 1, stdout: "", stderr: err.message }),
    });
    if (verdict === false) {
      resolve({ status: 1, stdout: "", stderr: "loop agent task queue is full" });
    } else if (verdict === "duplicate") {
      resolve({
        status: 1,
        stdout: "",
        stderr: "duplicate loop agent task is already queued or running",
      });
    }
  });
}

async function enqueueContextResetIfNeeded(
  deps: QueueDeps,
  sessionName: string,
  reset: LoopAgentPrompt["contextReset"],
): Promise<LoopRunCommandResult | null> {
  if (reset === undefined || reset === "none") return null;
  return new Promise((resolve) => {
    const verdict = deps.queue.enqueue({
      id: newMessageId(),
      text: "",
      chatId: "loop-engineering",
      sessionName,
      action: reset,
      channel: "control",
      origin: "system",
      promptSource: "control",
      resolve: (output) => resolve({ status: 0, stdout: output, stderr: "" }),
      reject: (err) => resolve({ status: 1, stdout: "", stderr: err.message }),
    });
    if (verdict === false) {
      resolve({ status: 1, stdout: "", stderr: "loop context reset queue is full" });
    } else if (verdict === "duplicate") {
      resolve({
        status: 1,
        stdout: "",
        stderr: "duplicate loop context reset is already queued or running",
      });
    }
  });
}

async function enqueueLoopAgentPromptToSession(
  deps: QueueDeps,
  sessionName: string,
  prompt: string,
  workOrder: LoopWorkOrder,
  contextReset?: SupervisorDispatchRequest["contextReset"],
  signal?: AbortSignal,
  timeoutMs?: number,
  deferLeaseUntilConsumption = false,
): Promise<LoopRunCommandResult> {
  if (signal?.aborted) {
    return { status: 1, stdout: "", stderr: "loop supervisor task was cancelled before enqueue" };
  }
  if (!(await deps.bridge.hasSession(sessionName))) {
    return {
      status: 1,
      stdout: "",
      stderr: `no live loop supervisor session "${sessionName}"`,
    };
  }
  if (signal?.aborted) {
    return { status: 1, stdout: "", stderr: "loop supervisor task was cancelled before enqueue" };
  }

  let leaseAcquired = false;
  const acquireLease = (): { status: "acquired" } | { status: "unavailable"; reason: string } => {
    const lease = leaseLoopSupervisorWorker({
      state: readLoopSupervisorWorkerLeaseState(),
      supervisorSession: sessionName,
      workOrder,
      now: Date.now(),
      retainFailureForMs:
        (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000,
    });
    writeLoopSupervisorWorkerLeaseState(lease.state);
    if (lease.status === "unavailable") {
      log.info("loop supervisor worker lease unavailable", {
        session: sessionName,
        data: { workOrderId: workOrder.id, projectId: workOrder.projectId, reason: lease.reason },
      });
      return { status: "unavailable", reason: lease.reason };
    }
    log.info("loop supervisor worker leased", {
      session: sessionName,
      data: {
        workOrderId: workOrder.id,
        projectId: workOrder.projectId,
        projectPath: workOrder.projectPath,
      },
    });
    return { status: "acquired" };
  };
  const releaseFailureLease = (): void => {
    if (leaseAcquired) {
      releaseSupervisorWorkerLease(workOrder, "failure");
      return;
    }
    if (!deferLeaseUntilConsumption) return;
    const hasPreReservedLease = readLoopSupervisorWorkerLeaseState().leases.some(
      (lease) =>
        lease.status === "active" &&
        lease.workerSession === sessionName &&
        lease.workOrderId === workOrder.id,
    );
    if (hasPreReservedLease) releaseSupervisorWorkerLease(workOrder, "failure");
  };
  if (!deferLeaseUntilConsumption) {
    const lease = acquireLease();
    if (lease.status === "unavailable") {
      return {
        status: 1,
        stdout: "",
        stderr: lease.reason,
      };
    }
    leaseAcquired = true;
  }

  const resetResult = await enqueueContextResetIfNeeded(deps, sessionName, contextReset);
  if (resetResult !== null && resetResult.status !== 0) {
    releaseFailureLease();
    return resetResult;
  }
  if (signal?.aborted) {
    releaseFailureLease();
    return { status: 1, stdout: "", stderr: "loop supervisor task was cancelled before enqueue" };
  }

  return new Promise((resolve) => {
    const messageId = newMessageId();
    let consumed = false;
    let consumptionTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      // Cancellation can remove only not-yet-started queue items. In-flight
      // supervisor turns remain serialized by the per-session queue and must
      // finish or be interrupted through the owning control surface.
      deps.queue.cancelQueued(sessionName, messageId, "loop supervisor task was cancelled");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const clearConsumptionTimer = (): void => {
      if (consumptionTimer !== undefined) clearTimeout(consumptionTimer);
    };
    const settle = (result: LoopRunCommandResult): void => {
      signal?.removeEventListener("abort", abort);
      clearConsumptionTimer();
      if (result.status !== 0) releaseFailureLease();
      resolve(result);
    };
    const verdict = deps.queue.enqueue({
      id: messageId,
      text: prompt,
      chatId: "loop-engineering",
      sessionName,
      action: "text",
      channel: "control",
      origin: "system",
      promptSource: "control",
      ...(timeoutMs !== undefined ? { maxWaitDoneTotalMs: timeoutMs } : {}),
      doneProbe: (output) =>
        output.includes(workOrder.requiredFinalMarker) ||
        parseSupervisorFinalSummaryFile(workOrder).ok,
      controlRestore: loopSupervisorControlRestore(workOrder, sessionName, Date.now()),
      started: () => {
        if (deferLeaseUntilConsumption) {
          const lease = acquireLease();
          if (lease.status === "unavailable") return false;
          leaseAcquired = true;
        }
        consumed = true;
        clearConsumptionTimer();
        writeLoopSupervisorWorkOrderState({
          workOrder,
          supervisorSession: sessionName,
          status: "in-flight",
          now: Date.now(),
        });
        return true;
      },
      resolve: (output) => settle({ status: 0, stdout: output, stderr: "" }),
      reject: (err) => settle({ status: 1, stdout: "", stderr: err.message }),
    });
    if (verdict === false) {
      settle({ status: 1, stdout: "", stderr: "loop supervisor task queue is full" });
    } else if (verdict === "duplicate") {
      settle({
        status: 1,
        stdout: "",
        stderr: "duplicate loop supervisor task is already queued or running",
      });
    } else {
      writeLoopSupervisorWorkOrderState({
        workOrder,
        supervisorSession: sessionName,
        status: "queued",
        now: Date.now(),
      });
      consumptionTimer = setTimeout(
        () => {
          if (consumed) return;
          const cancelled = deps.queue.cancelQueued(
            sessionName,
            messageId,
            "loop supervisor worker did not consume queued task before deadline",
          );
          if (!cancelled) {
            settle({
              status: 1,
              stdout: "",
              stderr: "loop supervisor worker did not consume queued task before deadline",
            });
          }
        },
        deferLeaseUntilConsumption
          ? (timeoutMs ?? DEFERRED_SUPERVISOR_QUEUE_TIMEOUT_MS)
          : SUPERVISOR_WORKER_CONSUMPTION_TIMEOUT_MS,
      );
      consumptionTimer.unref();
    }
  });
}

function releaseSupervisorWorkerLease(
  workOrder: LoopWorkOrder,
  result: "success" | "failure",
): void {
  const retainFailureForMs =
    (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000 ||
    DEFAULT_WORKER_FAILURE_RETAIN_MS;
  writeLoopSupervisorWorkerLeaseState(
    releaseLoopSupervisorWorker({
      state: readLoopSupervisorWorkerLeaseState(),
      workOrderId: workOrder.id,
      result,
      now: Date.now(),
      retainFailureForMs,
    }),
  );
  log.info("loop supervisor worker lease settled", {
    data: {
      workOrderId: workOrder.id,
      projectId: workOrder.projectId,
      result,
      retainFailureForMs,
    },
  });
}

export function createLoopQueueAgentTaskRunner(
  deps: QueueDeps,
): (invocation: LoopAgentTaskInvocation) => Promise<LoopRunCommandResult> {
  return (invocation) =>
    enqueueLoopAgentPrompt(deps, {
      cwd: invocation.cwd,
      agent: invocation.agent,
      prompt: invocation.prompt,
      projectId: invocation.projectId,
      ...(invocation.contextReset !== undefined ? { contextReset: invocation.contextReset } : {}),
    });
}

export function createLoopQueueAgentEvalRunner(
  deps: QueueDeps,
): (invocation: LoopAgentEvalInvocation) => Promise<LoopRunCommandResult> {
  return (invocation) =>
    enqueueLoopAgentPrompt(deps, {
      cwd: invocation.cwd,
      agent: invocation.agent,
      prompt: invocation.prompt,
      projectId: invocation.projectId,
    });
}

export function createLoopSupervisorTaskRunner(
  deps: QueueDeps,
  options: { deferLeaseUntilConsumption?: boolean } = {},
): (request: SupervisorDispatchRequest) => Promise<LoopRunCommandResult> {
  return (request) =>
    enqueueLoopAgentPromptToSession(
      deps,
      request.session,
      request.prompt,
      request.workOrder,
      request.contextReset,
      request.signal,
      request.timeoutMs,
      options.deferLeaseUntilConsumption ?? request.deferLeaseUntilConsumption ?? false,
    );
}

export function restoreLoopControlQueue(deps: ControlRestoreQueueDeps): number {
  const restored = restorePersistedChannel({
    channel: "control",
    loadPersisted: () => deps.queue.loadPersisted(),
    enqueue: (message) => deps.queue.enqueue(message),
    keepPersistedCarryover: (messages) => deps.queue.keepPersistedCarryover(messages),
    restore: (persisted) => {
      const message = restoredLoopSupervisorMessage(persisted);
      if (message !== null) return message;
      return shouldDiscardRestoredLoopSupervisorMessage(persisted) ? "discard" : null;
    },
  });
  return restored.restored;
}
