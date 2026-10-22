import { resolve as resolvePath } from "node:path";
import { normalizeLoopResourcePaths } from "./supervisor-dispatch-plan.js";
import { readLoopSupervisorWorkerLeaseState } from "./supervisor-pool.js";
import { listUnfinishedLoopSupervisorWorkOrders } from "./supervisor-state.js";
import type { LoopWorkOrder } from "./work-order.js";

export type ActiveLoopSupervisorResources = {
  supervisorSessions: Set<string>;
  projectPaths: Set<string>;
  resourcePaths: Set<string>;
};

/** Read all durable supervisor and worker reservations affecting one tick. */
export function readActiveLoopSupervisorResources(): ActiveLoopSupervisorResources {
  const supervisorSessions = new Set<string>();
  const projectPaths = new Set<string>();
  const resourcePaths = new Set<string>();
  for (const record of listUnfinishedLoopSupervisorWorkOrders()) {
    if (record.state.resultStatus === "invalid-output") continue;
    supervisorSessions.add(record.state.supervisorSession);
    projectPaths.add(record.workOrder.projectPath);
    for (const path of resourcePathsForLoopWorkOrder(record.workOrder)) resourcePaths.add(path);
  }
  for (const lease of readLoopSupervisorWorkerLeaseState().leases) {
    if (lease.status !== "active") continue;
    supervisorSessions.add(lease.workerSession);
    projectPaths.add(lease.projectPath);
    resourcePaths.add(resolvePath(lease.projectPath));
  }
  return { supervisorSessions, projectPaths, resourcePaths };
}

export function resourcePathsForLoopWorkOrder(workOrder: LoopWorkOrder): string[] {
  if (workOrder.workspace !== undefined) {
    return normalizeLoopResourcePaths([
      workOrder.workspace.root,
      ...workOrder.workspace.repositories.flatMap((repository) => [
        repository.path,
        ...(repository.sourcePath === undefined ? [] : [repository.sourcePath]),
      ]),
    ]);
  }
  return normalizeLoopResourcePaths([
    workOrder.projectPath,
    ...(workOrder.executionIsolation?.sourceWorktree === undefined
      ? []
      : [workOrder.executionIsolation.sourceWorktree]),
  ]);
}
