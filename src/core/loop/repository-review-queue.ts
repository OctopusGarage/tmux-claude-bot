import { createHash } from "node:crypto";
import { JsonMapStore } from "../infra/json-map-store.js";

export type RepositoryReviewQueueStatus =
  | "pending"
  | "leased"
  | "running"
  | "retry-wait"
  | "completed"
  | "blocked"
  | "manual-review"
  | "dead-letter";

export const REPOSITORY_REVIEW_MAX_ATTEMPTS = 5;

export type RepositoryReviewQueueItem = {
  id: string;
  repositoryId: string;
  scheduledAt: number;
  priority: number;
  status: RepositoryReviewQueueStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  leaseOwner?: string;
  leaseUntil?: number;
  lastError?: string;
  retryEpoch?: number;
  migration?: {
    previousStatus: "manual-review" | "dead-letter";
    previousAttempt: number;
    reason: string;
    migratedAt: number;
  };
};

type EnqueueInput = {
  repositoryId: string;
  scheduledAt: number;
  priority: number;
  now: number;
};

function queueId(repositoryId: string, scheduledAt: number): string {
  const digest = createHash("sha256")
    .update(`${repositoryId}\0${scheduledAt}`)
    .digest("hex")
    .slice(0, 16);
  return `repository-pr-review-${digest}`;
}

export class RepositoryReviewQueue {
  private readonly items = new JsonMapStore<RepositoryReviewQueueItem>(
    "repository-pr-review-queue.json",
  );

  enqueue(input: EnqueueInput): RepositoryReviewQueueItem {
    const id = queueId(input.repositoryId, input.scheduledAt);
    const existing = this.items.get(id);
    if (existing !== undefined) return existing;
    const item: RepositoryReviewQueueItem = {
      id,
      repositoryId: input.repositoryId,
      scheduledAt: input.scheduledAt,
      priority: input.priority,
      status: "pending",
      attempt: 0,
      createdAt: input.now,
      updatedAt: input.now,
      nextAttemptAt: input.now,
    };
    this.items.set(id, item);
    return item;
  }

  list(options: { all?: boolean } = {}): RepositoryReviewQueueItem[] {
    const now = Date.now();
    this.deadLetterExhausted(now);
    this.reclaimExpiredLeases(now);
    return this.items
      .sortedEntries()
      .map(([, item]) => item)
      .filter((item) => options.all === true || !isTerminal(item.status))
      .sort(
        (a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      );
  }

  listReady(now: number, limit = Number.POSITIVE_INFINITY): RepositoryReviewQueueItem[] {
    this.migrateLegacyBlocked(now);
    this.deadLetterExhausted(now);
    this.reclaimExpiredLeases(now);
    return this.items
      .sortedEntries()
      .map(([, item]) => item)
      .filter(
        (item) =>
          (item.status === "pending" || item.status === "retry-wait") && item.nextAttemptAt <= now,
      )
      .sort(
        (a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      )
      .slice(0, limit);
  }

  /**
   * Older queue versions recorded every unsuccessful review as terminal
   * `blocked`, without a decision reason. Modern `blocked` records are
   * evidence-backed terminal decisions, so only the unannotated legacy shape
   * is safe to reopen.
   */
  private migrateLegacyBlocked(now: number): void {
    for (const [id, item] of this.items.sortedEntries()) {
      if (item.status !== "blocked" || item.lastError !== undefined) continue;
      this.items.set(id, {
        ...item,
        status: "retry-wait",
        updatedAt: now,
        nextAttemptAt: now,
        lastError: "migrated legacy blocked repository review",
      });
    }
  }

  lease(id: string, owner: string, now: number, leaseMs: number): RepositoryReviewQueueItem | null {
    this.deadLetterExhausted(now);
    this.reclaimExpiredLeases(now);
    const item = this.items.get(id);
    if (
      item === undefined ||
      (item.status !== "pending" && item.status !== "retry-wait") ||
      item.nextAttemptAt > now
    ) {
      return null;
    }
    const leased: RepositoryReviewQueueItem = {
      ...item,
      status: "leased",
      attempt: item.attempt + 1,
      updatedAt: now,
      leaseOwner: owner,
      leaseUntil: now + leaseMs,
    };
    this.items.set(id, leased);
    return leased;
  }

  /**
   * Reconnect a queue occurrence to a supervisor WorkOrder that survived a
   * service restart. The WorkOrder is authoritative here; launching another
   * review would duplicate the work in its isolated worktree.
   */
  adoptRunning(
    repositoryId: string,
    scheduledAt: number,
    owner: string,
    now: number,
    leaseMs: number,
    hasActiveWorkerLease: boolean,
  ): RepositoryReviewQueueItem | null {
    if (!hasActiveWorkerLease) return null;
    const id = queueId(repositoryId, scheduledAt);
    const existing = this.items.get(id);
    if (existing?.status === "running" && existing.leaseOwner === owner) return existing;
    const leased = this.lease(id, owner, now, leaseMs);
    return leased === null ? null : this.markRunning(id, owner, now);
  }

  retryOccurrence(
    repositoryId: string,
    scheduledAt: number,
    now: number,
    error: string,
    nextAttemptAt: number,
  ): boolean {
    this.deadLetterExhausted(now);
    const id = queueId(repositoryId, scheduledAt);
    const item = this.items.get(id);
    if (
      item === undefined ||
      isTerminal(item.status) ||
      (item.status === "retry-wait" && item.lastError === error)
    ) {
      return false;
    }
    const retrying: RepositoryReviewQueueItem = {
      ...item,
      status: item.attempt >= REPOSITORY_REVIEW_MAX_ATTEMPTS ? "dead-letter" : "retry-wait",
      updatedAt: now,
      nextAttemptAt: item.attempt >= REPOSITORY_REVIEW_MAX_ATTEMPTS ? now : nextAttemptAt,
      lastError: error,
    };
    delete retrying.leaseOwner;
    delete retrying.leaseUntil;
    this.items.set(id, retrying);
    return true;
  }

  completeOccurrence(
    repositoryId: string,
    scheduledAt: number,
    now: number,
    status: "completed" | "blocked" | "manual-review",
    error?: string,
  ): boolean {
    const id = queueId(repositoryId, scheduledAt);
    const item = this.items.get(id);
    if (item === undefined || isTerminal(item.status)) return false;
    const terminal: RepositoryReviewQueueItem = {
      ...item,
      status,
      updatedAt: now,
      ...(error === undefined ? {} : { lastError: error }),
    };
    delete terminal.leaseOwner;
    delete terminal.leaseUntil;
    this.items.set(id, terminal);
    return true;
  }

  markRunning(id: string, owner: string, now: number): RepositoryReviewQueueItem | null {
    const item = this.items.get(id);
    if (item?.status !== "leased" || item.leaseOwner !== owner) return null;
    const running = { ...item, status: "running" as const, updatedAt: now };
    this.items.set(id, running);
    return running;
  }

  fail(id: string, owner: string, now: number, error: string, nextAttemptAt: number): boolean {
    const item = this.items.get(id);
    if (
      item === undefined ||
      (item.status !== "leased" && item.status !== "running") ||
      item.leaseOwner !== owner
    ) {
      return false;
    }
    const retrying: RepositoryReviewQueueItem = {
      ...item,
      status: item.attempt >= REPOSITORY_REVIEW_MAX_ATTEMPTS ? "dead-letter" : "retry-wait",
      updatedAt: now,
      nextAttemptAt: item.attempt >= REPOSITORY_REVIEW_MAX_ATTEMPTS ? now : nextAttemptAt,
      lastError: error,
    };
    delete retrying.leaseOwner;
    delete retrying.leaseUntil;
    this.items.set(id, retrying);
    return true;
  }

  retry(id: string, owner: string, now: number, error: string, nextAttemptAt: number): boolean {
    return this.fail(id, owner, now, error, nextAttemptAt);
  }

  manualReview(id: string, owner: string, now: number, reason: string): boolean {
    return this.complete(id, owner, now, "manual-review", reason);
  }

  reopenTerminal(id: string, input: { now: number; reason: string }): boolean {
    const item = this.items.get(id);
    if (
      item === undefined ||
      (item.status !== "manual-review" && item.status !== "dead-letter") ||
      !this.canRecoverTerminal(id)
    ) {
      return false;
    }
    const reopened: RepositoryReviewQueueItem = {
      ...item,
      status: "retry-wait",
      attempt: 0,
      retryEpoch: (item.retryEpoch ?? 0) + 1,
      updatedAt: input.now,
      nextAttemptAt: input.now,
      lastError: input.reason,
      migration: {
        previousStatus: item.status,
        previousAttempt: item.attempt,
        reason: input.reason,
        migratedAt: input.now,
      },
    };
    delete reopened.leaseOwner;
    delete reopened.leaseUntil;
    this.items.set(id, reopened);
    return true;
  }

  completeRecoveredTerminal(id: string, input: { now: number; reason: string }): boolean {
    const item = this.items.get(id);
    if (
      item === undefined ||
      (item.status !== "manual-review" && item.status !== "dead-letter") ||
      !this.canRecoverTerminal(id)
    ) {
      return false;
    }
    const completed: RepositoryReviewQueueItem = {
      ...item,
      status: "completed",
      updatedAt: input.now,
      nextAttemptAt: input.now,
      lastError: input.reason,
      migration: {
        previousStatus: item.status,
        previousAttempt: item.attempt,
        reason: input.reason,
        migratedAt: input.now,
      },
    };
    delete completed.leaseOwner;
    delete completed.leaseUntil;
    this.items.set(id, completed);
    return true;
  }

  canRecoverTerminal(id: string): boolean {
    const item = this.items.get(id);
    return (
      item !== undefined &&
      (item.status === "manual-review" || item.status === "dead-letter") &&
      item.migration === undefined &&
      !this.items
        .sortedEntries()
        .some(
          ([otherId, other]) =>
            otherId !== id &&
            other.repositoryId === item.repositoryId &&
            other.scheduledAt > item.scheduledAt &&
            !isTerminal(other.status),
        )
    );
  }

  complete(
    id: string,
    owner: string,
    now: number,
    status: "completed" | "blocked" | "manual-review",
    error?: string,
  ): boolean {
    const item = this.items.get(id);
    if (
      item === undefined ||
      (item.status !== "leased" && item.status !== "running") ||
      item.leaseOwner !== owner
    ) {
      return false;
    }
    const terminal: RepositoryReviewQueueItem = {
      ...item,
      status,
      updatedAt: now,
      ...(error === undefined ? {} : { lastError: error }),
    };
    delete terminal.leaseOwner;
    delete terminal.leaseUntil;
    this.items.set(id, terminal);
    return true;
  }

  private reclaimExpiredLeases(now: number): void {
    for (const [, item] of this.items.sortedEntries()) {
      if (
        (item.status !== "leased" && item.status !== "running") ||
        item.leaseUntil === undefined ||
        (item.leaseUntil > now && !leaseOwnerProcessExited(item.leaseOwner))
      ) {
        continue;
      }
      const recovered: RepositoryReviewQueueItem = {
        ...item,
        status: item.attempt >= REPOSITORY_REVIEW_MAX_ATTEMPTS ? "dead-letter" : "pending",
        updatedAt: now,
        nextAttemptAt: now,
        lastError: item.lastError ?? "repository review lease expired",
      };
      delete recovered.leaseOwner;
      delete recovered.leaseUntil;
      this.items.set(item.id, recovered);
    }
  }

  private deadLetterExhausted(now: number): void {
    for (const [id, item] of this.items.sortedEntries()) {
      if (
        (item.status !== "pending" && item.status !== "retry-wait") ||
        item.attempt < REPOSITORY_REVIEW_MAX_ATTEMPTS
      )
        continue;
      this.items.set(id, { ...item, status: "dead-letter", updatedAt: now, nextAttemptAt: now });
    }
  }
}

function leaseOwnerProcessExited(owner: string | undefined): boolean {
  const pidText = owner?.split(":", 1)[0];
  if (pidText === undefined || !/^\d+$/.test(pidText)) return false;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function isTerminal(status: RepositoryReviewQueueStatus): boolean {
  return (
    status === "completed" ||
    status === "blocked" ||
    status === "manual-review" ||
    status === "dead-letter"
  );
}
