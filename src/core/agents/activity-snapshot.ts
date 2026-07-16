import type { AgentKind } from "../../shared/types.js";
import type { HandlerDeps } from "../deps.js";
import type { UsageSnapshot } from "../read/usage.js";
import type { SessionTelemetryOptions } from "../session/session-telemetry.js";
import { readSessionTelemetry, SESSION_ACTIVITY_WINDOW_MS } from "../session/session-telemetry.js";
import { cumulativeBusyMs as cumulativeBusyMsOf, currentTask } from "../session/task-timing.js";

export type AgentActivityTask = {
  key: string;
  startedAt: number;
  source: "queue" | "transcript";
};

export type AgentActivitySnapshot = {
  kind: AgentKind | null;
  running: boolean;
  busy: boolean;
  queueBusy: boolean;
  transcriptBusy: boolean;
  paneAnimating: boolean;
  pathDrifted: boolean;
  taskMs?: number;
  task?: AgentActivityTask;
  cumulativeBusyMs: number;
  usage: UsageSnapshot | null;
};

export type AgentActivitySnapshotOptions = Pick<
  SessionTelemetryOptions,
  | "boundPath"
  | "now"
  | "activityWindowMs"
  | "paneDiffMs"
  | "includeQueue"
  | "includePaneAnimation"
  | "includePathDrift"
  | "includeUsage"
  | "agentKindMode"
  | "agentRunningMode"
  | "pathDriftFailure"
>;

/**
 * Agent Activity read model. It hides the implementation details behind one
 * interface: live/resolved agent kind, process state, queue-backed task timing,
 * transcript-backed desktop activity, pane animation fallback, usage, and cwd
 * drift. Callers should not reconstruct task identity or busy state themselves.
 */
export async function readAgentActivitySnapshot(
  deps: HandlerDeps,
  session: string,
  opts: AgentActivitySnapshotOptions = {},
): Promise<AgentActivitySnapshot> {
  const now = opts.now ?? Date.now();
  const telemetryOpts: SessionTelemetryOptions = {
    now,
    activityWindowMs: opts.activityWindowMs ?? SESSION_ACTIVITY_WINDOW_MS,
    includeCurrentTurn: true,
  };
  if (opts.boundPath !== undefined) telemetryOpts.boundPath = opts.boundPath;
  if (opts.paneDiffMs !== undefined) telemetryOpts.paneDiffMs = opts.paneDiffMs;
  if (opts.includeQueue !== undefined) telemetryOpts.includeQueue = opts.includeQueue;
  if (opts.includePaneAnimation !== undefined)
    telemetryOpts.includePaneAnimation = opts.includePaneAnimation;
  if (opts.includePathDrift !== undefined) telemetryOpts.includePathDrift = opts.includePathDrift;
  if (opts.includeUsage !== undefined) telemetryOpts.includeUsage = opts.includeUsage;
  if (opts.agentKindMode !== undefined) telemetryOpts.agentKindMode = opts.agentKindMode;
  if (opts.agentRunningMode !== undefined) telemetryOpts.agentRunningMode = opts.agentRunningMode;
  if (opts.pathDriftFailure !== undefined) telemetryOpts.pathDriftFailure = opts.pathDriftFailure;

  const telemetry = await readSessionTelemetry(deps, session, telemetryOpts);

  const current = currentTask(session, now);
  const cumulativeBusyMs = cumulativeBusyMsOf(session, now);
  const busy = current.busy || telemetry.busy;
  let taskMs = current.sinceMs;
  if (busy && taskMs === undefined && telemetry.currentTurnStartedAt !== null) {
    taskMs = Math.max(0, now - telemetry.currentTurnStartedAt);
  }

  const task =
    current.busy && current.startedAt !== undefined
      ? queueTask(deps, session, current.startedAt)
      : busy && telemetry.currentTurnStartedAt !== null
        ? {
            key: `transcript:${session}:${telemetry.currentTurnStartedAt}`,
            startedAt: telemetry.currentTurnStartedAt,
            source: "transcript" as const,
          }
        : undefined;

  return {
    kind: telemetry.agentKind,
    running: telemetry.agentRunning,
    busy,
    queueBusy: telemetry.queueBusy,
    transcriptBusy: telemetry.transcriptBusy,
    paneAnimating: telemetry.paneAnimating,
    pathDrifted: telemetry.pathDrifted,
    ...(taskMs !== undefined && { taskMs }),
    ...(task && { task }),
    cumulativeBusyMs,
    usage: telemetry.usage,
  };
}

function queueTask(deps: HandlerDeps, session: string, startedAt: number): AgentActivityTask {
  const currentMessage = (
    deps.queue as {
      getCurrentSessionMessage?: (sessionName: string) => { id: string } | undefined;
    }
  ).getCurrentSessionMessage?.(session);
  return {
    key: currentMessage ? `queue:${currentMessage.id}` : `queue:${session}:${startedAt}`,
    startedAt,
    source: "queue",
  };
}
