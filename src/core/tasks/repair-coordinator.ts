import { JsonMapStore } from "../infra/json-map-store.js";

export type RepairQueueStatus =
  | "pending"
  | "leased"
  | "running"
  | "retry-wait"
  | "fixed"
  | "blocked"
  | "not-reproducible"
  | "superseded"
  | "dead-letter";

export type RepairQueueRecord = {
  id: string;
  dedupeKey: string;
  projectId: string;
  projectPath: string;
  source: string;
  taskFamily: string;
  fingerprint: string;
  linkedTaskIds: string[];
  summaries: string[];
  status: RepairQueueStatus;
  priority: number;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  leaseId?: string;
  leaseExpiresAt?: number;
  workOrderId?: string;
};

export type RepairQueueStore = {
  get(id: string): RepairQueueRecord | undefined;
  set(id: string, value: RepairQueueRecord): void;
  update(mutator: (records: Record<string, RepairQueueRecord>) => boolean): boolean;
  list(): RepairQueueRecord[];
};

export class InMemoryRepairQueueStore implements RepairQueueStore {
  private readonly values = new Map<string, RepairQueueRecord>();

  get(id: string): RepairQueueRecord | undefined {
    const value = this.values.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }

  set(id: string, value: RepairQueueRecord): void {
    this.values.set(id, structuredClone(value));
  }

  update(mutator: (records: Record<string, RepairQueueRecord>) => boolean): boolean {
    const records = Object.fromEntries(
      [...this.values.entries()].map(([id, value]) => [id, structuredClone(value)]),
    );
    const changed = mutator(records);
    if (changed) {
      this.values.clear();
      for (const [id, value] of Object.entries(records)) {
        this.values.set(id, structuredClone(value));
      }
    }
    return changed;
  }

  list(): RepairQueueRecord[] {
    return [...this.values.values()].map((value) => structuredClone(value));
  }
}

class PersistentRepairQueueStore implements RepairQueueStore {
  private readonly store = new JsonMapStore<RepairQueueRecord>("repair_queue.json");

  get(id: string): RepairQueueRecord | undefined {
    return this.store.get(id);
  }

  set(id: string, value: RepairQueueRecord): void {
    this.store.set(id, value);
  }

  update(mutator: (records: Record<string, RepairQueueRecord>) => boolean): boolean {
    return this.store.update(mutator);
  }

  list(): RepairQueueRecord[] {
    return this.store.sortedEntries().map(([, value]) => value);
  }
}

export type RepairEnqueueInput = {
  projectId: string;
  projectPath: string;
  source: string;
  taskFamily: string;
  fingerprint: string;
  taskId: string;
  summary?: string;
  priority?: number;
  now: number;
};

export type RepairClaimInput = {
  now: number;
  leaseId: string;
  leaseMs?: number;
  limit: number;
  projectId?: string;
  sources?: readonly string[];
  excludeSources?: readonly string[];
};

type PendingLedgerRecord = {
  taskId: string;
  source: string;
  name: string;
  status: string;
  repairStatus?: string;
  failureKind?: string;
  error?: string;
  summary?: string;
  scheduledAt: number;
  updatedAt: number;
};

const DEFAULT_LEASE_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const REPAIR_MAX_ATTEMPTS = 3;

export function createRepairDedupeKey(input: {
  projectId: string;
  projectPath: string;
  source: string;
  taskFamily: string;
  fingerprint: string;
}): string {
  return [
    input.projectId.trim(),
    input.projectPath.trim(),
    input.taskFamily.trim(),
    input.fingerprint.trim(),
  ]
    .map((part) => part.replaceAll("|", "/"))
    .join("|");
}

export function repairBackoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.max(0, attempt - 1));
}

export class RepairCoordinator {
  constructor(private readonly store: RepairQueueStore = new PersistentRepairQueueStore()) {}

  enqueue(input: RepairEnqueueInput): RepairQueueRecord {
    const dedupeKey = createRepairDedupeKey(input);
    let existing = this.list().find(
      (record) => record.dedupeKey === dedupeKey && !isTerminal(record.status),
    );
    if (existing === undefined && input.source === "runtime-guardian") {
      existing = this.list().find(
        (record) =>
          record.source === "runtime-guardian" &&
          record.projectId === input.projectId &&
          record.taskFamily === input.taskFamily &&
          record.linkedTaskIds.includes(input.taskId) &&
          !isTerminal(record.status),
      );
    }
    if (existing === undefined && input.source === "project-recovery") {
      const stale = this.list().find(
        (record) =>
          record.dedupeKey === dedupeKey &&
          isTerminal(record.status) &&
          record.linkedTaskIds.includes(input.taskId) &&
          !hasNonRetryableProjectRecoveryEvidence(record, input),
      );
      if (stale !== undefined) {
        existing = reopenProjectRecoveryRecord(stale, input.now);
        this.store.set(existing.id, existing);
      }
    }
    if (existing === undefined && input.source === "project-recovery") {
      const stale = this.list()
        .filter((record) => isRecoverableProjectRecoveryTerminal(record, input))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
      if (stale !== undefined) {
        existing = reopenProjectRecoveryRecord(stale, input.now);
        this.store.set(existing.id, existing);
      }
    }
    const current = existing;
    if (current !== undefined) {
      if (input.source === "project-recovery") {
        for (const terminal of this.list().filter(
          (record) =>
            record.dedupeKey === dedupeKey &&
            isTerminal(record.status) &&
            record.linkedTaskIds.includes(input.taskId),
        )) {
          this.store.set(terminal.id, {
            ...terminal,
            status: "superseded",
            updatedAt: input.now,
          });
        }
      }
      const linkedTaskIds = current.linkedTaskIds.includes(input.taskId)
        ? current.linkedTaskIds
        : [...current.linkedTaskIds, input.taskId];
      const summaries =
        input.summary === undefined || current.summaries.includes(input.summary)
          ? current.summaries
          : [...current.summaries, input.summary];
      const updated = {
        ...current,
        linkedTaskIds,
        summaries,
        priority: Math.max(current.priority, input.priority ?? 0),
        updatedAt: input.now,
      };
      this.store.set(updated.id, updated);
      return updated;
    }

    const record: RepairQueueRecord = {
      id: `repair-${input.now}-${this.list().length + 1}`,
      dedupeKey,
      projectId: input.projectId,
      projectPath: input.projectPath,
      source: input.source,
      taskFamily: input.taskFamily,
      fingerprint: input.fingerprint,
      linkedTaskIds: [input.taskId],
      summaries: input.summary === undefined ? [] : [input.summary],
      status: "pending",
      priority: input.priority ?? 0,
      attempt: 0,
      createdAt: input.now,
      updatedAt: input.now,
      nextAttemptAt: input.now,
    };
    this.store.set(record.id, record);
    return record;
  }

  list(): RepairQueueRecord[] {
    return this.store.list().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  findOpenProjectRecovery(projectId: string): RepairQueueRecord | undefined {
    return this.list().find(
      (record) =>
        record.source === "project-recovery" &&
        record.projectId === projectId &&
        !isTerminal(record.status),
    );
  }

  linkTaskIds(id: string, taskIds: readonly string[], now: number): RepairQueueRecord | undefined {
    const record = this.store.get(id);
    if (record === undefined) return undefined;
    const linkedTaskIds = [...new Set([...record.linkedTaskIds, ...taskIds])];
    const updated = { ...record, linkedTaskIds, updatedAt: now };
    this.store.set(id, updated);
    return updated;
  }

  importPending(
    records: readonly PendingLedgerRecord[],
    input: { projectId: string; projectPath: string; now: number },
  ): number {
    let imported = 0;
    for (const record of records) {
      if (!isEligiblePendingRecord(record)) continue;
      this.enqueue({
        projectId: input.projectId,
        projectPath: input.projectPath,
        source: record.source,
        taskFamily: record.name,
        fingerprint: fingerprintForPendingRecord(record),
        taskId: record.taskId,
        ...(record.summary === undefined ? {} : { summary: record.summary }),
        priority: record.scheduledAt >= input.now - 48 * 60 * 60_000 ? 100 : 10,
        now: input.now,
      });
      imported++;
    }
    return imported;
  }

  claimDue(input: RepairClaimInput): RepairQueueRecord[] {
    this.deadLetterExhausted(input.now);
    const claimed = this.list()
      .filter(
        (record) =>
          (record.status === "pending" || record.status === "retry-wait") &&
          record.nextAttemptAt <= input.now &&
          (input.projectId === undefined || record.projectId === input.projectId) &&
          (input.sources === undefined || input.sources.includes(record.source)) &&
          (input.excludeSources === undefined || !input.excludeSources.includes(record.source)),
      )
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
      .slice(0, Math.max(0, input.limit));
    const expiresAt = input.now + (input.leaseMs ?? DEFAULT_LEASE_MS);
    this.store.update((records) => {
      for (const record of claimed) {
        records[record.id] = {
          ...record,
          status: "leased",
          leaseId: input.leaseId,
          leaseExpiresAt: expiresAt,
          updatedAt: input.now,
        };
      }
      return claimed.length > 0;
    });
    return claimed.map((record) => ({
      ...record,
      status: "leased",
      leaseId: input.leaseId,
      leaseExpiresAt: expiresAt,
      updatedAt: input.now,
    }));
  }

  claimIds(ids: readonly string[], input: RepairClaimInput): RepairQueueRecord[] {
    this.deadLetterExhausted(input.now);
    const wanted = new Set(ids);
    const due = this.list()
      .filter(
        (record) =>
          wanted.has(record.id) &&
          (record.status === "pending" || record.status === "retry-wait") &&
          record.nextAttemptAt <= input.now,
      )
      .slice(0, Math.max(0, input.limit));
    const expiresAt = input.now + (input.leaseMs ?? DEFAULT_LEASE_MS);
    this.store.update((records) => {
      for (const record of due) {
        records[record.id] = {
          ...record,
          status: "leased",
          leaseId: input.leaseId,
          leaseExpiresAt: expiresAt,
          updatedAt: input.now,
        };
      }
      return due.length > 0;
    });
    return due.map((record) => ({
      ...record,
      status: "leased",
      leaseId: input.leaseId,
      leaseExpiresAt: expiresAt,
      updatedAt: input.now,
    }));
  }

  markRunning(id: string, leaseId: string, now: number): RepairQueueRecord | undefined {
    const record = this.store.get(id);
    if (record?.leaseId !== leaseId || record.status !== "leased") return undefined;
    const updated = { ...record, status: "running" as const, updatedAt: now };
    this.store.set(id, updated);
    return updated;
  }

  attachWorkOrder(id: string, workOrderId: string, now: number): RepairQueueRecord | undefined {
    const record = this.store.get(id);
    if (record === undefined || record.status !== "running") return undefined;
    const updated = { ...record, workOrderId, updatedAt: now };
    this.store.set(id, updated);
    return updated;
  }

  markTerminal(
    id: string,
    status: Extract<
      RepairQueueStatus,
      "fixed" | "blocked" | "not-reproducible" | "superseded" | "dead-letter"
    >,
    now: number,
  ): RepairQueueRecord | undefined {
    const record = this.store.get(id);
    if (record === undefined) return undefined;
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = record;
    const updated = {
      ...withoutLease,
      status,
      updatedAt: now,
    };
    this.store.set(id, updated);
    return updated;
  }

  releaseForRetry(
    id: string,
    now: number,
    options: { detachWorkOrder?: boolean } = {},
  ): RepairQueueRecord | undefined {
    const record = this.store.get(id);
    if (record === undefined) return undefined;
    const attempt = record.attempt + 1;
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = record;
    const retryBase = options.detachWorkOrder
      ? (({ workOrderId: _workOrderId, ...withoutWorkOrder }) => withoutWorkOrder)(withoutLease)
      : withoutLease;
    const updated: RepairQueueRecord = {
      ...retryBase,
      status: attempt >= REPAIR_MAX_ATTEMPTS ? "dead-letter" : "retry-wait",
      attempt,
      nextAttemptAt: attempt >= REPAIR_MAX_ATTEMPTS ? now : now + repairBackoffMs(attempt),
      updatedAt: now,
    };
    this.store.set(id, updated);
    return updated;
  }

  releaseToQueue(id: string, now: number): RepairQueueRecord | undefined {
    const record = this.store.get(id);
    if (record === undefined) return undefined;
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = record;
    const updated: RepairQueueRecord = {
      ...withoutLease,
      status: "pending",
      nextAttemptAt: now,
      updatedAt: now,
    };
    this.store.set(id, updated);
    return updated;
  }

  reconcileDuplicateTaskIds(now: number): number {
    const active = this.list().filter((record) => !isTerminal(record.status));
    const byTaskId = new Map<string, RepairQueueRecord[]>();
    for (const record of active) {
      for (const taskId of record.linkedTaskIds) {
        const records = byTaskId.get(taskId) ?? [];
        records.push(record);
        byTaskId.set(taskId, records);
      }
    }
    const superseded = new Set<string>();
    for (const [taskId, records] of byTaskId) {
      const unique = [...new Map(records.map((record) => [record.id, record])).values()];
      if (unique.length < 2) continue;
      const derivedWorkOrderId = taskId.startsWith("autopilot:")
        ? taskId.slice("autopilot:".length)
        : undefined;
      if (
        derivedWorkOrderId !== undefined &&
        unique.every(
          (record) =>
            record.workOrderId === derivedWorkOrderId ||
            record.linkedTaskIds.some((linkedTaskId) => linkedTaskId !== taskId),
        )
      )
        continue;
      unique.sort(compareDuplicatePriority);
      const winner = unique[0];
      if (winner === undefined) continue;
      for (const loser of unique) {
        if (loser.id === winner.id || superseded.has(loser.id)) continue;
        this.markTerminal(loser.id, "superseded", now);
        superseded.add(loser.id);
      }
    }
    return superseded.size;
  }

  reconcileFromLedger(
    records: readonly (Pick<PendingLedgerRecord, "taskId" | "repairStatus"> & {
      status?: string;
    })[],
    now: number,
  ): number {
    const byTaskId = new Map(records.map((record) => [record.taskId, record]));
    let reconciled = 0;
    for (const queueRecord of this.list()) {
      // A pending record can become obsolete while another linked recovery
      // WorkOrder is executing. Reconcile it too; otherwise a successful
      // recovery leaves a permanently pending duplicate that can be claimed
      // again on a later audit.
      if (!new Set(["pending", "leased", "running", "retry-wait"]).has(queueRecord.status))
        continue;
      const linkedRecords = queueRecord.linkedTaskIds.map((taskId) => byTaskId.get(taskId));
      if (linkedRecords.some((record) => record !== undefined && record.repairStatus === undefined))
        continue;
      const outcomes = linkedRecords
        .map((record) => record?.repairStatus)
        .filter((status): status is string => status !== undefined);
      const knownOutcomesAreTerminal = outcomes.every((status) =>
        new Set(["fixed", "not-needed", "blocked", "not-reproducible", "superseded"]).has(status),
      );
      if (outcomes.length !== queueRecord.linkedTaskIds.length) {
        // A historical task can disappear from the ledger during migration or
        // cleanup. If every remaining linked outcome is terminal, preserve the
        // uncertainty as a visible terminal blocker instead of retrying forever.
        if (outcomes.length > 0 && knownOutcomesAreTerminal) {
          this.markTerminal(queueRecord.id, "blocked", now);
          reconciled++;
        }
        continue;
      }
      if (!knownOutcomesAreTerminal) continue;
      const status = outcomes.some((outcome) => outcome === "blocked")
        ? "blocked"
        : outcomes.every((outcome) => outcome === "superseded")
          ? "superseded"
          : "fixed";
      this.markTerminal(queueRecord.id, status, now);
      reconciled++;
    }
    return reconciled;
  }

  reconcileExpiredLeases(now: number): number {
    let count = 0;
    this.store.update((records) => {
      for (const [id, record] of Object.entries(records)) {
        if (
          (record.status !== "leased" && record.status !== "running") ||
          record.leaseExpiresAt === undefined ||
          record.leaseExpiresAt > now
        )
          continue;
        const attempt = record.attempt + 1;
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = record;
        records[id] = {
          ...withoutLease,
          status: attempt >= REPAIR_MAX_ATTEMPTS ? "dead-letter" : "retry-wait",
          attempt,
          nextAttemptAt: attempt >= REPAIR_MAX_ATTEMPTS ? now : now + repairBackoffMs(attempt),
          updatedAt: now,
        };
        count++;
      }
      return count > 0;
    });
    return count;
  }

  private deadLetterExhausted(now: number): number {
    let count = 0;
    this.store.update((records) => {
      for (const [id, record] of Object.entries(records)) {
        if (
          (record.status !== "pending" && record.status !== "retry-wait") ||
          record.attempt < REPAIR_MAX_ATTEMPTS
        )
          continue;
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = record;
        records[id] = {
          ...withoutLease,
          status: "dead-letter",
          updatedAt: now,
        };
        count++;
      }
      return count > 0;
    });
    return count;
  }

  pruneTerminal(now: number, retentionMs: number = TERMINAL_RETENTION_MS): number {
    let deleted = 0;
    this.store.update((records) => {
      for (const [id, record] of Object.entries(records)) {
        if (!isTerminal(record.status)) continue;
        if (record.createdAt > now || now - record.createdAt <= retentionMs) continue;
        delete records[id];
        deleted++;
      }
      return deleted > 0;
    });
    return deleted;
  }
}

function isTerminal(status: RepairQueueStatus): boolean {
  return ["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(status);
}

function reopenProjectRecoveryRecord(record: RepairQueueRecord, now: number): RepairQueueRecord {
  const {
    leaseId: _leaseId,
    leaseExpiresAt: _leaseExpiresAt,
    workOrderId: _workOrderId,
    ...withoutLease
  } = record;
  return {
    ...withoutLease,
    status: "pending",
    attempt: 0,
    nextAttemptAt: now,
    updatedAt: now,
  };
}

function isRecoverableProjectRecoveryTerminal(
  record: RepairQueueRecord,
  input: RepairEnqueueInput,
): boolean {
  if (record.source !== "project-recovery" || record.projectId !== input.projectId) return false;
  if (record.status !== "blocked" || record.attempt >= REPAIR_MAX_ATTEMPTS) return false;
  if (hasNonRetryableProjectRecoveryEvidence(record, input)) return false;
  const evidence = projectRecoveryEvidence(record, input);
  if (evidence.includes("recovery attempt limit reached")) return false;
  if (evidence.includes("dead-letter")) return false;
  if (evidence.includes("needs-owner-decision") && !hasRecoverableProjectRecoveryEvidence(evidence))
    return false;
  return hasRecoverableProjectRecoveryEvidence(evidence);
}

function hasNonRetryableProjectRecoveryEvidence(
  record: RepairQueueRecord,
  input: RepairEnqueueInput,
): boolean {
  const evidence = projectRecoveryEvidence(record, input);
  if (evidence.includes("no retryable project repair remains")) return true;
  if (evidence.includes("recovery attempt limit reached")) return true;
  if (evidence.includes("dead-letter")) return true;
  return (
    evidence.includes("needs-owner-decision") && !hasRecoverableProjectRecoveryEvidence(evidence)
  );
}

function projectRecoveryEvidence(record: RepairQueueRecord, input: RepairEnqueueInput): string {
  return [...record.summaries, input.summary, record.fingerprint, input.fingerprint]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
}

function hasRecoverableProjectRecoveryEvidence(evidence: string): boolean {
  return (
    evidence.includes("can be retried") ||
    evidence.includes("invalid-final-summary") ||
    evidence.includes("invalid final summary") ||
    evidence.includes("incomplete recovery") ||
    evidence.includes("source worktree") ||
    evidence.includes("source branch") ||
    evidence.includes("branch divergence") ||
    evidence.includes("branch state")
  );
}

function compareDuplicatePriority(a: RepairQueueRecord, b: RepairQueueRecord): number {
  const statusRank = (status: RepairQueueStatus): number =>
    status === "running" ? 3 : status === "leased" ? 2 : status === "pending" ? 1 : 0;
  const sourceRank = (source: string): number =>
    source === "project-recovery" ? 3 : source === "runtime-guardian" ? 2 : 1;
  return (
    statusRank(b.status) - statusRank(a.status) ||
    sourceRank(b.source) - sourceRank(a.source) ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

function isEligiblePendingRecord(record: PendingLedgerRecord): boolean {
  if (record.repairStatus !== "pending") return false;
  if (!new Set(["failed", "missing", "running-timeout"]).has(record.status)) return false;
  return record.source === "daily-audit" || isBotOwnedTaskName(record.name);
}

function fingerprintForPendingRecord(record: PendingLedgerRecord): string {
  if (record.failureKind !== undefined) return record.failureKind;
  if (record.error !== undefined) return record.error;
  if (record.status === "missing") return "missing-run-record";
  if (record.status === "running-timeout") return "running-timeout";
  return record.summary ?? "unknown";
}

function isBotOwnedTaskName(name: string): boolean {
  return name === "tmux-claude-bot" || name.startsWith("tmux-claude-bot ");
}
