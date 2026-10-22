import type {
  LoopConfig,
  LoopProjectConfig,
  LoopRepositoryPullRequestReviewConfig,
  LoopWorkspaceConfig,
} from "./config.js";
import type { runLoopSchedulerTick } from "./scheduler.js";
import type { LoopDueTarget } from "./supervisor-dispatch-plan.js";

export function resolveLoopSupervisorDueTarget(
  config: LoopConfig,
  due: ReturnType<typeof runLoopSchedulerTick>["dueProjects"][number],
): LoopDueTarget {
  const workspaceJob = due.jobKey.startsWith("workspace:");
  const project =
    due.jobKind === "repository-pull-request-review" || workspaceJob
      ? undefined
      : config.projects.find((candidate) => candidate.id === due.projectId);
  const repository =
    due.jobKind === "repository-pull-request-review"
      ? config.prReview.repositories.find((candidate) => candidate.id === due.projectId)
      : undefined;
  const workspace = workspaceJob
    ? config.workspaces.find((candidate) => candidate.id === due.projectId)
    : undefined;
  if (project === undefined && repository === undefined && workspace === undefined) {
    throw new Error(`loop scheduler produced unknown target "${due.projectId}"`);
  }
  return {
    due,
    ...(project === undefined ? {} : { project }),
    ...(repository === undefined ? {} : { repository }),
    ...(workspace === undefined ? {} : { workspace }),
    projectPath: requiredProjectPath(project, repository, workspace, due.projectId),
  };
}

function requiredProjectPath(
  project: LoopProjectConfig | undefined,
  repository: LoopRepositoryPullRequestReviewConfig | undefined,
  workspace: LoopWorkspaceConfig | undefined,
  targetId: string,
): string {
  const path = project?.path ?? repository?.path ?? workspace?.root;
  if (path === undefined) throw new Error(`loop scheduler produced unknown target "${targetId}"`);
  return path;
}
