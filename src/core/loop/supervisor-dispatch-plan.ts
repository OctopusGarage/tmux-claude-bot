import { resolve as resolvePath, sep } from "node:path";
import type {
  LoopProjectConfig,
  LoopRepositoryPullRequestReviewConfig,
  LoopWorkspaceConfig,
} from "./config.js";
import type { runLoopSchedulerTick } from "./scheduler.js";

export type LoopDueTarget = {
  due: ReturnType<typeof runLoopSchedulerTick>["dueProjects"][number];
  project?: LoopProjectConfig;
  repository?: LoopRepositoryPullRequestReviewConfig;
  workspace?: LoopWorkspaceConfig;
  projectPath: string;
};

export type LoopSupervisorDispatchPlan = {
  ready: LoopDueTarget[];
  skipped: Array<{ target: LoopDueTarget; reason: string }>;
  deferred: Array<{ target: LoopDueTarget; reason: string; conflictsWith: string[] }>;
};

/**
 * Classify due WorkOrders for one supervisor tick without reserving workers or
 * changing durable state. The caller owns admission, dispatch, and settlement.
 */
export function planLoopSupervisorDispatch(input: {
  targets: readonly LoopDueTarget[];
  activeResourcePaths: ReadonlySet<string>;
}): LoopSupervisorDispatchPlan {
  const ready: LoopDueTarget[] = [];
  const skipped: LoopSupervisorDispatchPlan["skipped"] = [];
  const deferred: LoopSupervisorDispatchPlan["deferred"] = [];
  const selectedResources: Array<{ owner: string; path: string }> = [];
  const selectedHarnesses: LoopDueTarget[] = [];
  const ordered = input.targets
    .map((target, index) => ({ target, index }))
    .sort(
      (left, right) =>
        targetPriority(left.target) - targetPriority(right.target) || left.index - right.index,
    );

  for (const { target } of ordered) {
    const activeConflicts = conflictingResourceOwners(
      resourcePathsForLoopDispatchTarget(target),
      [...input.activeResourcePaths].map((path) => ({ owner: "active-work", path })),
    );
    if (activeConflicts.length > 0) {
      deferred.push({
        target,
        reason: "target overlaps active loop supervisor work",
        conflictsWith: activeConflicts,
      });
      continue;
    }

    const harness = selectedHarnesses.find((candidate) => harnessCovers(candidate, target));
    if (harness !== undefined) {
      skipped.push({
        target,
        reason: `${harness.due.jobKey} harness-auto covers ${taskFamily(target)}`,
      });
      continue;
    }

    const resourceConflicts = conflictingResourceOwners(
      resourcePathsForLoopDispatchTarget(target),
      selectedResources,
    );
    if (resourceConflicts.length > 0) {
      deferred.push({
        target,
        reason: "target overlaps another due target selected for this tick",
        conflictsWith: resourceConflicts,
      });
      continue;
    }

    ready.push(target);
    const owner = target.due.jobKey;
    for (const path of resourcePathsForLoopDispatchTarget(target)) {
      selectedResources.push({ owner, path });
    }
    if (target.due.jobKind === "harness-auto") selectedHarnesses.push(target);
  }

  return {
    ready: restoreDueOrder(ready, input.targets),
    skipped: restoreSkippedOrder(skipped, input.targets),
    deferred,
  };
}

export function resourcePathsForLoopDispatchTarget(target: LoopDueTarget): string[] {
  if (target.workspace !== undefined) {
    return normalizeLoopResourcePaths([
      target.workspace.root,
      ...target.workspace.repositories.map((repository) => repository.path),
    ]);
  }
  return normalizeLoopResourcePaths([target.projectPath]);
}

export function normalizeLoopResourcePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolvePath(path)))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function targetPriority(target: LoopDueTarget): number {
  if (target.due.jobKind === "harness-auto") return 0;
  if (taskFamily(target) === "architecture") return 1;
  if (taskFamily(target) === "security-maintenance") return 2;
  if (taskFamily(target) === "bug-fix") return 3;
  if (taskFamily(target) === "test-coverage") return 4;
  if (target.due.jobKind === "repository-pull-request-review") return 5;
  if (target.due.jobKind === "pull-request-review") return 6;
  return 7;
}

function restoreDueOrder<T extends LoopDueTarget>(
  items: T[],
  original: readonly LoopDueTarget[],
): T[] {
  const index = new Map(original.map((target, idx) => [target.due.jobKey, idx]));
  return [...items].sort(
    (left, right) => (index.get(left.due.jobKey) ?? 0) - (index.get(right.due.jobKey) ?? 0),
  );
}

function restoreSkippedOrder(
  items: LoopSupervisorDispatchPlan["skipped"],
  original: readonly LoopDueTarget[],
): LoopSupervisorDispatchPlan["skipped"] {
  const index = new Map(original.map((target, idx) => [target.due.jobKey, idx]));
  return [...items].sort(
    (left, right) =>
      (index.get(left.target.due.jobKey) ?? 0) - (index.get(right.target.due.jobKey) ?? 0),
  );
}

function taskFamily(target: LoopDueTarget): string {
  return target.due.jobKind === "workspace-architecture" ? "architecture" : target.due.jobKind;
}

function harnessCovers(harness: LoopDueTarget, target: LoopDueTarget): boolean {
  if (harness === target || harness.due.jobKind !== "harness-auto") return false;
  const family = taskFamily(target);
  if (
    family !== "architecture" &&
    family !== "bug-fix" &&
    family !== "test-coverage" &&
    family !== "security-maintenance"
  ) {
    return false;
  }
  const tasks = harness.project?.harnessAuto.tasks ?? harness.workspace?.harnessAuto.tasks ?? [];
  if (!tasks.some((task) => task.kind === family && task.enabled)) return false;
  return resourcesConflict(
    resourcePathsForLoopDispatchTarget(harness),
    resourcePathsForLoopDispatchTarget(target),
  );
}

function conflictingResourceOwners(
  candidatePaths: readonly string[],
  existing: readonly { owner: string; path: string }[],
): string[] {
  return [
    ...new Set(
      existing
        .filter((item) => candidatePaths.some((candidate) => pathsOverlap(candidate, item.path)))
        .map((item) => item.owner),
    ),
  ];
}

function resourcesConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => pathsOverlap(leftPath, rightPath)));
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}
