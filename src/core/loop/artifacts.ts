import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";

export const LOOP_RUNS_DIR_NAME = "loop-runs";

export const LOOP_RUN_ARTIFACTS = {
  commandMarkdown: "report.md",
  commandSummary: "summary.json",
  supervisorMarkdown: "supervisor.md",
  supervisorSummary: "supervisor-summary.json",
  supervisorFinalSummary: "supervisor-final-summary.json",
  handoffJson: "handoff.json",
  handoffMarkdown: "handoff.md",
  systemGate: "system-gate.json",
  workOrder: "work-order.json",
  workOrderState: "work-order-state.json",
  opportunities: "opportunities.json",
} as const;

export type LoopRunArtifactKind = keyof typeof LOOP_RUN_ARTIFACTS;

export function loopRunsRoot(stateDir = appStateDir()): string {
  return join(stateDir, LOOP_RUNS_DIR_NAME);
}

export function loopRunDir(projectId: string, runId: string, stateDir?: string): string {
  return join(loopRunsRoot(stateDir), projectId, runId);
}

export function loopRunArtifactPath(
  projectId: string,
  runId: string,
  kind: LoopRunArtifactKind,
  stateDir?: string,
): string {
  return join(loopRunDir(projectId, runId, stateDir), LOOP_RUN_ARTIFACTS[kind]);
}
