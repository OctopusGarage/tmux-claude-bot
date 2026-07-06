import type { AgentKind } from "../../shared/types.js";
import type { HandlerDeps } from "../deps.js";
import { readSessionTelemetry, SHORT_ACTIVITY_WINDOW_MS } from "../session/session-telemetry.js";

/** A transcript written within this window means the agent is actively working.
 * Slightly above the runner's 5s idle window to bridge brief think gaps. */
export const TRANSCRIPT_IDLE_MS = SHORT_ACTIVITY_WINDOW_MS;

export type AgentActivityStatus = {
  agentKind: AgentKind | null;
  agentRunning: boolean;
  agentBusy: boolean;
  pathDrifted: boolean;
};

export function stoppedAgentActivity(): AgentActivityStatus {
  return { agentKind: null, agentRunning: false, agentBusy: false, pathDrifted: false };
}

/**
 * One read model for live agent state shown in project/session lists. It combines
 * process detection, queue state, transcript activity, and cwd drift behind one
 * small interface so adapters and project summaries do not reimplement activity
 * heuristics.
 */
export async function inspectAgentActivity(
  deps: HandlerDeps,
  session: string,
  boundPath: string | null,
): Promise<AgentActivityStatus> {
  const telemetry = await readSessionTelemetry(deps, session, {
    boundPath,
    activityWindowMs: TRANSCRIPT_IDLE_MS,
    includePathDrift: true,
    agentKindMode: "live",
    agentRunningMode: "live-kind",
    pathDriftFailure: "throw",
  });

  return {
    agentKind: telemetry.agentKind,
    agentRunning: telemetry.agentRunning,
    agentBusy: telemetry.busy,
    pathDrifted: telemetry.pathDrifted,
  };
}
