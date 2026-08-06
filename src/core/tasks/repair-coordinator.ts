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
};

export type RepairQueueStore = {
  get(id: string): RepairQueueRecord | undefined;
  set(id: string, value: RepairQueueRecord): void;
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
    if (existing === undefined && input.source === "project-recovery") {
      const stale = this.list().find(
        (record) =>
          record.dedupeKey === dedupeKey &&
          isTerminal(record.status) &&
          record.linkedTaskIds.includes(input.taskId),
      );
      if (stale !== undefined) {
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = stale;
        existing = {
          ...withoutLease,
          status: "pending",
          attempt: 0,
          nextAttemptAt: input.now,
          updatedAt: input.now,
        };
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
        fingerprint: record.failureKind ?? record.error ?? record.summary ?? "unknown",
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
    for (const record of claimed) {
      this.store.set(record.id, {
        ...record,
        status: "leased",
        leaseId: input.leaseId,
        leaseExpiresAt: expiresAt,
        updatedAt: input.now,
      });
    }
    return claimed.map((record) => ({
      ...record,
      status: "leased",
      leaseId: input.leaseId,
      leaseExpiresAt: expiresAt,
      updatedAt: input.now,
    }));
  }

  claimIds(ids: readonly string[], input: RepairClaimInput): RepairQueueRecord[] {
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
    for (const record of due) {
      this.store.set(record.id, {
        ...record,
        status: "leased",
        leaseId: input.leaseId,
        leaseExpiresAt: expiresAt,
        updatedAt: input.now,
      });
    }
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

  releaseForRetry(id: string, now: number): RepairQueueRecord | undefined {
    const record = this.store.get(id);
    if (record === undefined) return undefined;
    const attempt = record.attempt + 1;
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = record;
    const updated: RepairQueueRecord = {
      ...withoutLease,
      status: "retry-wait",
      attempt,
      nextAttemptAt: now + repairBackoffMs(attempt),
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
    for (const records of byTaskId.values()) {
      const unique = [...new Map(records.map((record) => [record.id, record])).values()];
      if (unique.length < 2) continue;
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
    records: readonly Pick<PendingLedgerRecord, "taskId" | "repairStatus">[],
    now: number,
  ): number {
    const byTaskId = new Map(records.map((record) => [record.taskId, record.repairStatus]));
    let reconciled = 0;
    for (const queueRecord of this.list()) {
      // A pending record can become obsolete while another linked recovery
      // WorkOrder is executing. Reconcile it too; otherwise a successful
      // recovery leaves a permanently pending duplicate that can be claimed
      // again on a later audit.
      if (!new Set(["pending", "leased", "running", "retry-wait"]).has(queueRecord.status))
        continue;
      const outcomes = queueRecord.linkedTaskIds
        .map((taskId) => byTaskId.get(taskId))
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
    for (const record of this.list()) {
      if (
        (record.status !== "leased" && record.status !== "running") ||
        record.leaseExpiresAt === undefined ||
        record.leaseExpiresAt > now
      )
        continue;
      const attempt = record.attempt + 1;
      const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = record;
      const updated: RepairQueueRecord = {
        ...withoutLease,
        status: "retry-wait",
        attempt,
        nextAttemptAt: now + repairBackoffMs(attempt),
        updatedAt: now,
      };
      this.store.set(record.id, updated);
      count++;
    }
    return count;
  }
}

function isTerminal(status: RepairQueueStatus): boolean {
  return ["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(status);
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

function isBotOwnedTaskName(name: string): boolean {
  return name === "tmux-claude-bot" || name.startsWith("tmux-claude-bot ");
}
