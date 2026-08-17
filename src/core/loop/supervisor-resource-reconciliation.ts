import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import { DailyTaskLedger } from "../tasks/task-ledger.js";
import {
  cleanupLoopExecutionWorktree,
  createLoopExecutionWorktreeCleanup,
  isBotOwnedLoopExecutionWorktree,
} from "./execution-worktree.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import { LoopSchedulerStore } from "./scheduler.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import { resourcePathsForLoopWorkOrder } from "./supervisor-active-resources.js";
import { settleSupervisorWorkOrderOutcome } from "./supervisor-outcome-settlement.js";
import {
  readLoopSupervisorWorkerLeaseState,
  releaseLoopSupervisorWorker,
  writeLoopSupervisorWorkerLeaseState,
} from "./supervisor-pool.js";
import {
  type LoopSupervisorWorkOrderStateStatus,
  listAbandonedLoopSupervisorWorkOrders,
  listTerminalLoopSupervisorWorkOrders,
  readLoopSupervisorWorkOrderRegistry,
  STALE_DISPATCHING_WORK_ORDER_MS,
  writeLoopSupervisorWorkOrderState,
} from "./supervisor-state.js";
import type { LoopWorkOrder } from "./work-order.js";
import { loopLedgerTaskId, workerLeaseOutcome } from "./work-order-settlement.js";

const log = createLogger("loop.supervisor-resource-reconciliation");
const ORPHAN_WORKTREE_RETENTION_MS = 72 * 60 * 60 * 1_000;

export type SupervisorResourceReconciliation = {
  settledTerminalLeases: number;
  abandonedWorkOrders: number;
  removedTerminalWorktrees: number;
  removedExpiredWorktrees: number;
  removedOrphanWorktrees: number;
  removedStaleLeases: number;
  cleanedTerminalWorkerSessions: number;
};

export async function reconcileTerminalSupervisorResources(input: {
  now: number;
  excludedWorkOrderIds?: ReadonlySet<string>;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  cleanupWorkerSession?: (sessionName: string) => Promise<void> | void;
  workerSessionExists?: (sessionName: string) => Promise<boolean> | boolean;
  workerSessionOwnsActiveTurn?: (input: {
    workerSession: string;
    workOrder: LoopWorkOrder;
  }) => Promise<boolean> | boolean;
}): Promise<SupervisorResourceReconciliation> {
  const schedulerStore = new LoopSchedulerStore();
  const taskLedger = new DailyTaskLedger();
  const removedStaleLeases = reconcileStaleLoopSupervisorWorkerLeases();
  const settledTerminalLeases = reconcileTerminalLoopSupervisorWorkerLeases(input.now);
  const abandonedActiveLeases = await reconcileAbandonedActiveLoopSupervisorWorkerLeases(
    input.now,
    taskLedger,
    schedulerStore,
    input.excludedWorkOrderIds,
    input.workerSessionOwnsActiveTurn,
  );
  const abandonedWorkOrders = reconcileAbandonedLoopSupervisorWorkOrders(
    input.now,
    taskLedger,
    schedulerStore,
    input.excludedWorkOrderIds,
  );
  const cleanedTerminalWorkerSessions =
    input.cleanupWorkerSession === undefined
      ? 0
      : await reconcileTerminalLoopSupervisorWorkerSessions({
          cleanupWorkerSession: input.cleanupWorkerSession,
          ...(input.workerSessionExists === undefined
            ? {}
            : { workerSessionExists: input.workerSessionExists }),
        });
  const removedTerminalWorktrees =
    input.runGit === undefined
      ? 0
      : reconcileTerminalLoopSupervisorWorktrees({ now: input.now, runGit: input.runGit });
  const removedExpiredWorktrees =
    input.runGit === undefined
      ? 0
      : reconcileExpiredLoopSupervisorWorkerWorktrees({ now: input.now, runGit: input.runGit });
  const removedOrphanWorktrees =
    input.runGit === undefined
      ? 0
      : reconcileOrphanLoopSupervisorWorktrees({ now: input.now, runGit: input.runGit });

  if (settledTerminalLeases > 0) {
    log.info("loop engineering terminal supervisor worker leases reconciled", {
      data: { settled: settledTerminalLeases },
    });
  }
  if (removedStaleLeases > 0) {
    log.info("loop engineering stale supervisor worker leases removed", {
      data: { removed: removedStaleLeases },
    });
  }
  if (abandonedWorkOrders > 0) {
    log.info("loop engineering abandoned supervisor worker leases reconciled", {
      data: { settled: abandonedWorkOrders },
    });
  }
  if (abandonedActiveLeases > 0) {
    log.info("loop engineering abandoned active supervisor worker leases reconciled", {
      data: { settled: abandonedActiveLeases },
    });
  }
  if (cleanedTerminalWorkerSessions > 0) {
    log.info("loop engineering terminal worker sessions cleaned up", {
      data: { cleaned: cleanedTerminalWorkerSessions },
    });
  }
  if (removedTerminalWorktrees > 0) {
    log.info("loop engineering terminal supervisor worktrees reconciled", {
      data: { removed: removedTerminalWorktrees },
    });
  }
  if (removedExpiredWorktrees > 0) {
    log.info("loop engineering expired supervisor worktrees reconciled", {
      data: { removed: removedExpiredWorktrees },
    });
  }
  if (removedOrphanWorktrees > 0) {
    log.info("loop engineering orphan supervisor worktrees reconciled", {
      data: { removed: removedOrphanWorktrees },
    });
  }
  return {
    settledTerminalLeases,
    abandonedWorkOrders: abandonedWorkOrders + abandonedActiveLeases,
    removedTerminalWorktrees,
    removedExpiredWorktrees,
    removedOrphanWorktrees,
    removedStaleLeases,
    cleanedTerminalWorkerSessions,
  };
}

async function reconcileAbandonedActiveLoopSupervisorWorkerLeases(
  now: number,
  taskLedger: DailyTaskLedger,
  schedulerStore: LoopSchedulerStore,
  excludedWorkOrderIds: ReadonlySet<string> = new Set(),
  workerSessionOwnsActiveTurn?: (input: {
    workerSession: string;
    workOrder: LoopWorkOrder;
  }) => Promise<boolean> | boolean,
): Promise<number> {
  if (workerSessionOwnsActiveTurn === undefined) return 0;
  const activeLeasesByWorkOrder = new Map(
    readLoopSupervisorWorkerLeaseState()
      .leases.filter((lease) => lease.status === "active")
      .map((lease) => [lease.workOrderId, lease]),
  );
  if (activeLeasesByWorkOrder.size === 0) return 0;

  let settled = 0;
  for (const record of readLoopSupervisorWorkOrderRegistry(now).unfinished) {
    if (excludedWorkOrderIds.has(record.workOrder.id)) continue;
    if (record.state.status !== "queued" && record.state.status !== "dispatching") continue;
    if (now - record.state.updatedAt <= STALE_DISPATCHING_WORK_ORDER_MS) continue;
    if (parseWorkerFinalSummaryExists(record.workOrder)) continue;
    const lease = activeLeasesByWorkOrder.get(record.workOrder.id);
    if (lease === undefined) continue;
    if (
      await workerSessionOwnsActiveTurn({
        workerSession: lease.workerSession,
        workOrder: record.workOrder,
      })
    ) {
      continue;
    }

    const existing = taskLedger
      .listAll()
      .find((task) => task.taskId === loopLedgerTaskId(record.workOrder));
    settleSupervisorWorkOrderOutcome({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      startedAt: record.state.updatedAt,
      endedAt: now,
      resultStatus: "dispatch-timeout",
      stateStatus: "failed",
      reportPath: record.runDir,
      failureSummary:
        "Reconciled stale supervisor dispatch timeout after the active worker lease stopped owning an active turn.",
      advanceScheduler: true,
      ...(existing?.status === "failed" || existing?.status === "success"
        ? { skipLedger: true }
        : {}),
      writeState: writeLoopSupervisorWorkOrderState,
      settleLease: settleLoopSupervisorWorkerLeaseForStatus,
      scheduler: schedulerStore,
      ledger: taskLedger,
    });
    writeLoopSupervisorWorkOrderState({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      status: "failed",
      now,
      resultStatus: "dispatch-timeout",
      revisionReasons: ["active supervisor worker lease no longer owns an active queue turn"],
    });
    settled++;
  }
  return settled;
}

function parseWorkerFinalSummaryExists(workOrder: LoopWorkOrder): boolean {
  return workOrder.finalSummaryPath !== undefined && existsSync(workOrder.finalSummaryPath);
}

/**
 * Recover worktrees left behind when a process died after `git worktree add`
 * but before its WorkOrder became durable. Recorded WorkOrders and every lease
 * remain authoritative; an unreferenced directory must also age past the normal
 * failure-evidence window before the existing verified Git cleanup may remove it.
 */
function reconcileOrphanLoopSupervisorWorktrees(input: {
  now: number;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): number {
  const root = join(appStateDir(), "loop-worktrees");
  if (!existsSync(root)) return 0;

  const referenced = new Set<string>();
  for (const { workOrder } of readLoopSupervisorWorkOrderRegistry(input.now).records) {
    for (const path of resourcePathsForLoopWorkOrder(workOrder)) {
      if (isBotOwnedLoopExecutionWorktree(path)) referenced.add(resolvePath(path));
    }
  }
  for (const lease of readLoopSupervisorWorkerLeaseState().leases) {
    if (isBotOwnedLoopExecutionWorktree(lease.projectPath)) {
      referenced.add(resolvePath(lease.projectPath));
    }
  }

  let projectEntries: Dirent<string>[];
  try {
    projectEntries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    log.warn("loop failed to scan the supervisor worktree root", { err, data: { root } });
    return 0;
  }

  const cleanupWorktree = createLoopExecutionWorktreeCleanup(input.runGit);
  let removed = 0;
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = join(root, projectEntry.name);
    let worktreeEntries: Dirent<string>[];
    try {
      worktreeEntries = readdirSync(projectDir, { withFileTypes: true });
    } catch (err) {
      log.warn("loop failed to scan a supervisor project worktree directory", {
        err,
        data: { projectDir },
      });
      continue;
    }
    for (const worktreeEntry of worktreeEntries) {
      if (!worktreeEntry.isDirectory()) continue;
      const worktree = resolvePath(projectDir, worktreeEntry.name);
      if (referenced.has(worktree)) continue;
      let lastTouchedAt: number;
      try {
        lastTouchedAt = statSync(worktree).mtimeMs;
      } catch (err) {
        log.warn("loop failed to inspect a possible orphan supervisor worktree", {
          err,
          data: { worktree },
        });
        continue;
      }
      if (lastTouchedAt + ORPHAN_WORKTREE_RETENTION_MS > input.now) continue;
      if (cleanupWorktree({ worktree }) === "removed") removed++;
    }
  }
  return removed;
}

function reconcileStaleLoopSupervisorWorkerLeases(): number {
  const state = readLoopSupervisorWorkerLeaseState();
  const remaining = state.leases.filter(
    (lease) => !isBotOwnedLoopExecutionWorktree(lease.projectPath) || existsSync(lease.projectPath),
  );
  const removed = state.leases.length - remaining.length;
  if (removed > 0) writeLoopSupervisorWorkerLeaseState({ leases: remaining });
  return removed;
}

async function reconcileTerminalLoopSupervisorWorkerSessions(input: {
  cleanupWorkerSession: (sessionName: string) => Promise<void> | void;
  workerSessionExists?: (sessionName: string) => Promise<boolean> | boolean;
}): Promise<number> {
  const sessions = new Set<string>();
  for (const record of listTerminalLoopSupervisorWorkOrders()) {
    const workerSession = record.workOrder.workerSession;
    if (workerSession !== undefined) sessions.add(workerSession);
  }
  let cleaned = 0;
  for (const session of sessions) {
    try {
      if (input.workerSessionExists !== undefined && !(await input.workerSessionExists(session))) {
        continue;
      }
      await input.cleanupWorkerSession(session);
      cleaned++;
    } catch (err) {
      log.warn("failed to clean up terminal loop worker session", {
        err,
        data: { session },
      });
    }
  }
  return cleaned;
}

function reconcileTerminalLoopSupervisorWorkerLeases(now: number): number {
  const activeLeasedWorkOrders = new Set(
    readLoopSupervisorWorkerLeaseState()
      .leases.filter((lease) => lease.status === "active")
      .map((lease) => lease.workOrderId),
  );
  let settled = 0;
  for (const record of listTerminalLoopSupervisorWorkOrders()) {
    if (!activeLeasedWorkOrders.has(record.workOrder.id)) continue;
    settleLoopSupervisorWorkerLeaseForStatus(
      record.workOrder,
      record.state.resultStatus ?? terminalStateToResultStatus(record.state.status),
      now,
    );
    settled++;
  }
  return settled;
}

function reconcileAbandonedLoopSupervisorWorkOrders(
  now: number,
  taskLedger: DailyTaskLedger,
  schedulerStore: LoopSchedulerStore,
  excludedWorkOrderIds: ReadonlySet<string> = new Set(),
): number {
  let settled = 0;
  for (const record of listAbandonedLoopSupervisorWorkOrders()) {
    if (excludedWorkOrderIds.has(record.workOrder.id)) continue;
    const existing = taskLedger
      .listAll()
      .find((task) => task.taskId === loopLedgerTaskId(record.workOrder));
    settleSupervisorWorkOrderOutcome({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      startedAt: record.state.updatedAt,
      endedAt: now,
      resultStatus: "dispatch-timeout",
      stateStatus: "failed",
      reportPath: record.runDir,
      failureSummary:
        "Reconciled stale supervisor dispatch timeout without an active worker lease.",
      advanceScheduler: true,
      ...(existing?.status === "failed" || existing?.status === "success"
        ? { skipLedger: true }
        : {}),
      writeState: writeLoopSupervisorWorkOrderState,
      settleLease: settleLoopSupervisorWorkerLeaseForStatus,
      scheduler: schedulerStore,
      ledger: taskLedger,
    });
    settled++;
  }
  return settled;
}

function terminalStateToResultStatus(
  status: LoopSupervisorWorkOrderStateStatus,
): LoopSupervisedRunResult["status"] {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "supervisor-failed";
}

function settleLoopSupervisorWorkerLeaseForStatus(
  workOrder: LoopWorkOrder,
  resultStatus: LoopSupervisedRunResult["status"],
  now: number,
  cleanupFailed = false,
): void {
  const retainFailureForMs =
    (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000;
  writeLoopSupervisorWorkerLeaseState(
    releaseLoopSupervisorWorker({
      state: readLoopSupervisorWorkerLeaseState(),
      workOrderId: workOrder.id,
      result: workerLeaseOutcome(resultStatus, cleanupFailed),
      now,
      retainFailureForMs,
    }),
  );
}

function isPreparedIsolatedExecutionWorktree(workOrder: LoopWorkOrder): boolean {
  return (
    workOrder.executionIsolation?.preparedBy === "system-git-worktree" &&
    workOrder.executionIsolation.worktreeIsolation === "isolated" &&
    isBotOwnedLoopExecutionWorktree(workOrder.projectPath)
  );
}

function reconcileTerminalLoopSupervisorWorktrees(input: {
  now: number;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): number {
  let removed = 0;
  const cleanupWorktree = createLoopExecutionWorktreeCleanup(input.runGit);
  for (const record of listTerminalLoopSupervisorWorkOrders()) {
    if (!isPreparedIsolatedExecutionWorktree(record.workOrder)) continue;
    const retainFailureForMs =
      (record.workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000;
    const eligibleAt =
      record.state.status === "completed"
        ? record.state.updatedAt
        : record.state.updatedAt + retainFailureForMs;
    if (eligibleAt > input.now) continue;
    if (
      cleanupWorktree({
        worktree: record.workOrder.projectPath,
        ...(record.workOrder.commitPolicy.branch === undefined
          ? {}
          : { expectedBranch: record.workOrder.commitPolicy.branch }),
        ...(record.workOrder.executionIsolation?.sourceWorktree === undefined
          ? {}
          : { sourceWorktree: record.workOrder.executionIsolation.sourceWorktree }),
      }) === "removed"
    ) {
      removed++;
    }
  }
  return removed;
}

function reconcileExpiredLoopSupervisorWorkerWorktrees(input: {
  now: number;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): number {
  const state = readLoopSupervisorWorkerLeaseState();
  const expired = state.leases.filter(
    (lease) => lease.status === "retained" && (lease.retainUntil ?? Infinity) <= input.now,
  );
  if (expired.length === 0) return 0;

  let removed = 0;
  const remaining = state.leases.filter((lease) => {
    if (!expired.includes(lease) || !isBotOwnedLoopExecutionWorktree(lease.projectPath))
      return true;
    if (!cleanupLoopExecutionWorktree({ worktree: lease.projectPath, runGit: input.runGit }))
      return true;
    removed++;
    return false;
  });
  if (remaining.length !== state.leases.length) {
    writeLoopSupervisorWorkerLeaseState({ leases: remaining });
  }
  return removed;
}
