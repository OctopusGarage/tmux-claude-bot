import type { ConfigResolver } from "../agents/agent-config-resolver.js";
import type { AgentKind } from "../agents/types.js";
import { newMessageId } from "../command/enqueue.js";
import type { MessageQueue } from "../command/queue.js";
import { restorePersistedChannel } from "../command/queue-restore.js";
import { resolveLiveSessionName, sessionNameFromPath } from "../projects/sessionPathMap.js";
import type {
  LoopAgentEvalInvocation,
  LoopAgentTaskInvocation,
  LoopRunCommandResult,
} from "./run.js";
import type { SupervisorDispatchRequest } from "./supervised-runner.js";
import {
  loopSupervisorControlRestore,
  restoredLoopSupervisorMessage,
} from "./supervisor-work-restore.js";
import type { LoopWorkOrder } from "./work-order.js";

type QueueDeps = {
  bridge: { hasSession(sessionName: string): Promise<boolean> };
  config: { projectSessionPrefix: string };
  configResolver?: Pick<ConfigResolver, "detectAgentKind">;
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
};

async function resolveProjectSession(deps: QueueDeps, cwd: string): Promise<string | null> {
  const intended = sessionNameFromPath(cwd, deps.config.projectSessionPrefix);
  return resolveLiveSessionName(deps.bridge, intended);
}

async function enqueueLoopAgentPrompt(
  deps: QueueDeps,
  prompt: LoopAgentPrompt,
): Promise<LoopRunCommandResult> {
  const sessionName = await resolveProjectSession(deps, prompt.cwd);
  if (sessionName === null) {
    return {
      status: 1,
      stdout: "",
      stderr: `no live project session for loop project "${prompt.projectId}"`,
    };
  }
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

async function enqueueLoopAgentPromptToSession(
  deps: QueueDeps,
  sessionName: string,
  prompt: string,
  workOrder: LoopWorkOrder,
  signal?: AbortSignal,
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

  return new Promise((resolve) => {
    const messageId = newMessageId();
    const abort = (): void => {
      // Cancellation can remove only not-yet-started queue items. In-flight
      // supervisor turns remain serialized by the per-session queue and must
      // finish or be interrupted through the owning control surface.
      deps.queue.cancelQueued?.(sessionName, messageId, "loop supervisor task was cancelled");
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
      controlRestore: loopSupervisorControlRestore(workOrder, sessionName, Date.now()),
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
      request.signal,
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
