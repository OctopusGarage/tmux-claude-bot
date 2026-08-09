import { existsSync } from "node:fs";
import { createLogger } from "../../shared/utils/logger.js";
import { DailyTaskLedger } from "../tasks/task-ledger.js";
import {
  cleanupLoopExecutionWorktree,
  isBotOwnedLoopExecutionWorktree,
} from "./execution-worktree.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import { LoopSchedulerStore } from "./scheduler.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
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
  writeLoopSupervisorWorkOrderState,
} from "./supervisor-state.js";
import type { LoopWorkOrder } from "./work-order.js";
import { loopLedgerTaskId, workerLeaseOutcome } from "./work-order-settlement.js";

const log = createLogger("loop.supervisor-resource-reconciliation");

export type SupervisorResourceReconciliation = {
  settledTerminalLeases: number;
  abandonedWorkOrders: number;
  removedTerminalWorktrees: number;
  removedExpiredWorktrees: number;
  removedStaleLeases: number;
  cleanedTerminalWorkerSessions: number;
};

export async function reconcileTerminalSupervisorResources(input: {
  now: number;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  cleanupWorkerSession?: (sessionName: string) => Promise<void> | void;
  workerSessionExists?: (sessionName: string) => Promise<boolean> | boolean;
}): Promise<SupervisorResourceReconciliation> {
  const schedulerStore = new LoopSchedulerStore();
  const taskLedger = new DailyTaskLedger();
  const removedStaleLeases = reconcileStaleLoopSupervisorWorkerLeases();
  const settledTerminalLeases = reconcileTerminalLoopSupervisorWorkerLeases(input.now);
  const abandonedWorkOrders = reconcileAbandonedLoopSupervisorWorkOrders(
    input.now,
    taskLedger,
    schedulerStore,
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
  return {
    settledTerminalLeases,
    abandonedWorkOrders,
    removedTerminalWorktrees,
    removedExpiredWorktrees,
    removedStaleLeases,
    cleanedTerminalWorkerSessions,
  };
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
): number {
  let settled = 0;
  for (const record of listAbandonedLoopSupervisorWorkOrders()) {
    const existing = taskLedger
      .listAll()
      .find((task) => task.taskId === loopLedgerTaskId(record.workOrder));
    settleSupervisorWorkOrderOutcome({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      startedAt: record.state.updatedAt,
      endedAt: now,
      resultStatus: "invalid-output",
      stateStatus: "failed",
      reportPath: record.runDir,
      failureSummary: "Reconciled stale supervisor dispatch without an active worker lease.",
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
  for (const record of listTerminalLoopSupervisorWorkOrders()) {
    if (!isPreparedIsolatedExecutionWorktree(record.workOrder)) continue;
    const retainFailureForMs =
      (record.workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000;
    const eligibleAt =
      record.state.status === "completed"
        ? record.state.updatedAt
        : record.state.updatedAt + retainFailureForMs;
    if (eligibleAt > input.now || !existsSync(record.workOrder.projectPath)) continue;
    if (
      cleanupLoopExecutionWorktree({ worktree: record.workOrder.projectPath, runGit: input.runGit })
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
