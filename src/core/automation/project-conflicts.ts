import { resolve } from "node:path";
import {
  listRecoverableFailedLoopSupervisorWorkOrders,
  listUnfinishedLoopSupervisorWorkOrders,
  type UnfinishedLoopSupervisorWorkOrder,
} from "../loop/supervisor-state.js";
import { getPathBySession } from "../projects/sessionPathMap.js";

export type ProjectAutomationConflict = {
  source: "loop-supervisor-work-order";
  projectPath: string;
  projectId: string;
  runId: string;
  taskKind: string;
  status: string;
  supervisorSession: string;
  runDir: string;
};

export function listReservedLoopSupervisorWorkOrders(): UnfinishedLoopSupervisorWorkOrder[] {
  const byRunDir = new Map<string, UnfinishedLoopSupervisorWorkOrder>();
  for (const record of [
    ...listUnfinishedLoopSupervisorWorkOrders(),
    ...listRecoverableFailedLoopSupervisorWorkOrders(),
  ]) {
    byRunDir.set(record.runDir, record);
  }
  return [...byRunDir.values()];
}

export function findProjectAutomationConflict(
  projectPath: string,
): ProjectAutomationConflict | null {
  const targetPath = resolve(projectPath);
  const record =
    listReservedLoopSupervisorWorkOrders().find((candidate) =>
      workOrderResourcePaths(candidate.workOrder).some((path) => resolve(path) === targetPath),
    ) ?? null;
  if (record === null) return null;
  return {
    source: "loop-supervisor-work-order",
    projectPath: record.workOrder.projectPath,
    projectId: record.workOrder.projectId,
    runId: record.workOrder.id,
    taskKind: record.workOrder.task?.kind ?? "loop-engineering",
    status: record.state.status,
    supervisorSession: record.state.supervisorSession,
    runDir: record.runDir,
  };
}

function workOrderResourcePaths(workOrder: UnfinishedLoopSupervisorWorkOrder["workOrder"]) {
  if (workOrder.workspace !== undefined) {
    return [
      workOrder.workspace.root,
      ...workOrder.workspace.repositories.map((repository) => repository.path),
    ];
  }
  return [workOrder.projectPath];
}

export function findProjectAutomationConflictForSession(
  session: string,
): ProjectAutomationConflict | null {
  const projectPath = getPathBySession(session);
  if (projectPath === null) return null;
  return findProjectAutomationConflict(projectPath);
}
