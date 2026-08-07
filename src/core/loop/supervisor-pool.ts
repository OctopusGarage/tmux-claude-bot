import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";

export type LoopSupervisorResetMode = "none" | "compact" | "clear";

export type LoopSupervisorBatchItem<T> = {
  item: T;
  supervisorSession: string;
};

export type LoopSupervisorWorkerLease = {
  workerSession: string;
  workOrderId: string;
  projectId: string;
  projectPath: string;
  status: "active" | "retained";
  leasedAt: number;
  updatedAt: number;
  retainUntil?: number;
};

export type LoopSupervisorWorkerLeaseState = {
  leases: LoopSupervisorWorkerLease[];
};

export type LoopSupervisorWorkerLeaseWorkOrder = {
  id: string;
  projectId: string;
  projectPath: string;
};

function leaseStatePath(): string {
  return join(appStateDir(), "loop-supervisor-worker-leases.json");
}

export function readLoopSupervisorWorkerLeaseState(): LoopSupervisorWorkerLeaseState {
  const path = leaseStatePath();
  if (!existsSync(path)) return { leases: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseLoopSupervisorWorkerLeaseState(parsed);
  } catch {
    return { leases: [] };
  }
}

export function writeLoopSupervisorWorkerLeaseState(state: LoopSupervisorWorkerLeaseState): void {
  const path = leaseStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function allocateLoopSupervisorBatches<T extends { projectPath: string }>(
  items: readonly T[],
  supervisorSessions: readonly string[],
): Array<Array<LoopSupervisorBatchItem<T>>> {
  if (items.length === 0) return [];
  if (supervisorSessions.length === 0) {
    return items.map((item) => [{ item, supervisorSession: "unconfigured-loop-supervisor" }]);
  }

  const pending = items.map((item, index) => ({ item, index }));
  const batches: Array<Array<LoopSupervisorBatchItem<T>>> = [];

  while (pending.length > 0) {
    const usedPaths = new Set<string>();
    const selectedIndexes = new Set<number>();
    const batch: Array<LoopSupervisorBatchItem<T>> = [];

    for (const candidate of pending) {
      if (batch.length >= supervisorSessions.length) break;
      if (usedPaths.has(candidate.item.projectPath)) continue;
      const supervisorSession = supervisorSessions[batch.length];
      if (supervisorSession === undefined) break;
      usedPaths.add(candidate.item.projectPath);
      selectedIndexes.add(candidate.index);
      batch.push({ item: candidate.item, supervisorSession });
    }

    batches.push(batch);
    for (let idx = pending.length - 1; idx >= 0; idx--) {
      if (selectedIndexes.has(pending[idx]?.index ?? -1)) pending.splice(idx, 1);
    }
  }

  return batches;
}

export function leaseLoopSupervisorWorker(input: {
  state: LoopSupervisorWorkerLeaseState;
  supervisorSession: string;
  workOrder: LoopSupervisorWorkerLeaseWorkOrder;
  now: number;
  retainFailureForMs: number;
}):
  | {
      status: "leased";
      state: LoopSupervisorWorkerLeaseState;
      lease: LoopSupervisorWorkerLease;
    }
  | { status: "unavailable"; state: LoopSupervisorWorkerLeaseState; reason: string } {
  const state = pruneExpiredRetainedLeases(input.state, input.now);
  const existing = state.leases.find(
    (lease) => lease.workerSession === input.supervisorSession && lease.status === "active",
  );
  if (existing !== undefined && existing.workOrderId !== input.workOrder.id) {
    return {
      status: "unavailable",
      state,
      reason: `worker ${input.supervisorSession} is leased by ${existing.workOrderId}`,
    };
  }

  const lease: LoopSupervisorWorkerLease = {
    workerSession: input.supervisorSession,
    workOrderId: input.workOrder.id,
    projectId: input.workOrder.projectId,
    projectPath: input.workOrder.projectPath,
    status: "active",
    leasedAt: existing?.leasedAt ?? input.now,
    updatedAt: input.now,
  };
  return {
    status: "leased",
    state: {
      leases: [
        ...state.leases.filter(
          (entry) =>
            entry.workOrderId !== lease.workOrderId &&
            entry.workerSession !== input.supervisorSession,
        ),
        lease,
      ],
    },
    lease,
  };
}

export function releaseLoopSupervisorWorker(input: {
  state: LoopSupervisorWorkerLeaseState;
  workOrderId: string;
  result: "success" | "failure";
  now: number;
  retainFailureForMs: number;
}): LoopSupervisorWorkerLeaseState {
  const state = pruneExpiredRetainedLeases(input.state, input.now);
  if (input.result === "success") {
    return {
      leases: state.leases.filter((lease) => lease.workOrderId !== input.workOrderId),
    };
  }
  return {
    leases: state.leases.map((lease) =>
      lease.workOrderId === input.workOrderId
        ? {
            ...lease,
            status: "retained",
            updatedAt: input.now,
            retainUntil: input.now + input.retainFailureForMs,
          }
        : lease,
    ),
  };
}

export function pruneExpiredRetainedLeases(
  state: LoopSupervisorWorkerLeaseState,
  now: number,
): LoopSupervisorWorkerLeaseState {
  return {
    leases: state.leases.filter(
      (lease) => lease.status === "active" || (lease.retainUntil ?? 0) > now,
    ),
  };
}

export function consumeExpiredRetainedSupervisorWorkerLeases(
  state: LoopSupervisorWorkerLeaseState,
  now: number,
): {
  state: LoopSupervisorWorkerLeaseState;
  expired: LoopSupervisorWorkerLease[];
} {
  const expired: LoopSupervisorWorkerLease[] = [];
  const leases = state.leases.filter((lease) => {
    if (lease.status !== "retained" || (lease.retainUntil ?? 0) > now) return true;
    expired.push(lease);
    return false;
  });
  return { state: { leases }, expired };
}

function parseLoopSupervisorWorkerLeaseState(value: unknown): LoopSupervisorWorkerLeaseState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { leases: [] };
  const record = value as { leases?: unknown };
  if (!Array.isArray(record.leases)) return { leases: [] };
  return {
    leases: record.leases.flatMap((lease) => {
      const parsed = parseLoopSupervisorWorkerLease(lease);
      return parsed === null ? [] : [parsed];
    }),
  };
}

function parseLoopSupervisorWorkerLease(value: unknown): LoopSupervisorWorkerLease | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<LoopSupervisorWorkerLease>;
  if (
    typeof record.workerSession !== "string" ||
    typeof record.workOrderId !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.projectPath !== "string" ||
    (record.status !== "active" && record.status !== "retained") ||
    typeof record.leasedAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    workerSession: record.workerSession,
    workOrderId: record.workOrderId,
    projectId: record.projectId,
    projectPath: record.projectPath,
    status: record.status,
    leasedAt: record.leasedAt,
    updatedAt: record.updatedAt,
    ...(typeof record.retainUntil === "number" ? { retainUntil: record.retainUntil } : {}),
  };
}
