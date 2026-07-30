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
import { writeLoopSupervisorWorkOrderState } from "./supervisor-state.js";
import {
  loopSupervisorControlRestore,
  restoredLoopSupervisorMessage,
} from "./supervisor-work-restore.js";
import type { LoopWorkOrder } from "./work-order.js";

const log = createLogger("loop.agent-queue");

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

  const resetResult = await enqueueContextResetIfNeeded(deps, sessionName, contextReset);
  if (resetResult !== null && resetResult.status !== 0) return resetResult;
  if (signal?.aborted) {
    return { status: 1, stdout: "", stderr: "loop supervisor task was cancelled before enqueue" };
  }

  return new Promise((resolve) => {
    const messageId = newMessageId();
    const abort = (): void => {
      // Cancellation can remove only not-yet-started queue items. In-flight
      // supervisor turns remain serialized by the per-session queue and must
      // finish or be interrupted through the owning control surface.
      deps.queue.cancelQueued(sessionName, messageId, "loop supervisor task was cancelled");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const settle = (result: LoopRunCommandResult): void => {
      signal?.removeEventListener("abort", abort);
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
      controlRestore: loopSupervisorControlRestore(workOrder, sessionName, Date.now()),
      started: () =>
        writeLoopSupervisorWorkOrderState({
          workOrder,
          supervisorSession: sessionName,
          status: "in-flight",
          now: Date.now(),
        }),
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
    }
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
    );
}

export function restoreLoopControlQueue(deps: ControlRestoreQueueDeps): number {
  const restored = restorePersistedChannel({
    channel: "control",
    loadPersisted: () => deps.queue.loadPersisted(),
    enqueue: (message) => deps.queue.enqueue(message),
    keepPersistedCarryover: (messages) => deps.queue.keepPersistedCarryover(messages),
    restore: (persisted) => restoredLoopSupervisorMessage(persisted),
  });
  return restored.restored;
}
