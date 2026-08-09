import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";
import { buildProjectRecoveryPrompt } from "../prompts/repair-prompts.js";
import type {
  ConfiguredRecoveryTarget,
  HistoricalRecoveryClassification,
} from "./project-recovery.js";

export type ProjectRecoveryDispatchInput = {
  target: ConfiguredRecoveryTarget;
  taskFamily: string;
  taskIds: string[];
  classification: HistoricalRecoveryClassification;
  evidence: string[];
};

export type ProjectRecoveryDispatchResult =
  | { status: "queued"; runId: string; detail: string }
  | { status: "blocked"; detail: string };

export type ProjectRecoveryDelegator = (input: {
  session: string;
  requirement: string;
  worktreeIsolation: "source" | "isolated";
}) => Promise<{ status: "queued"; runId: string } | { status: "blocked"; reason: string }>;

export function projectRecoveryLockKey(target: ConfiguredRecoveryTarget): string {
  return `${target.kind}:${target.id}`;
}

export async function dispatchProjectRecovery(
  input: ProjectRecoveryDispatchInput,
  options: {
    projectSessionPrefix: string;
    worktreeIsolation: "source" | "isolated";
    delegate: ProjectRecoveryDelegator;
  },
): Promise<ProjectRecoveryDispatchResult> {
  const session = sessionNameFromPath(input.target.path, options.projectSessionPrefix);
  setPathForSession(session, input.target.path);
  const result = await options.delegate({
    session,
    requirement: buildProjectRecoveryPrompt({
      projectId: input.target.id,
      projectPath: input.target.path,
      taskFamily: input.taskFamily,
      classification: input.classification.classification,
      reason: input.classification.reason,
      taskIds: input.taskIds,
      evidence: input.evidence,
    }),
    worktreeIsolation: options.worktreeIsolation,
  });
  if (result.status === "blocked") return { status: "blocked", detail: result.reason };
  return {
    status: "queued",
    runId: result.runId,
    detail: `runId=${result.runId} project=${input.target.id}`,
  };
}

export function createProjectRecoveryDelegator(deps: HandlerDeps): ProjectRecoveryDelegator {
  return async (input) => {
    const result = await startActiveDelegatedTask(deps, {
      ...input,
      resourceTrigger: "background",
    });
    if (result.status === "blocked") return { status: "blocked", reason: result.reason };
    return { status: "queued", runId: result.runId };
  };
}
