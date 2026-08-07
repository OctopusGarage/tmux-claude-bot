import { createHash } from "node:crypto";
import { JsonMapStore } from "../infra/json-map-store.js";

export type RepositoryReviewQueueStatus =
  | "pending"
  | "leased"
  | "running"
  | "retry-wait"
  | "completed"
  | "blocked"
  | "manual-review";

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

  lease(id: string, owner: string, now: number, leaseMs: number): RepositoryReviewQueueItem | null {
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
      status: "retry-wait",
      updatedAt: now,
      nextAttemptAt,
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
        item.leaseUntil > now
      ) {
        continue;
      }
      const recovered: RepositoryReviewQueueItem = {
        ...item,
        status: "pending",
        updatedAt: now,
        nextAttemptAt: now,
        lastError: item.lastError ?? "repository review lease expired",
      };
      delete recovered.leaseOwner;
      delete recovered.leaseUntil;
      this.items.set(item.id, recovered);
    }
  }
}

function isTerminal(status: RepositoryReviewQueueStatus): boolean {
  return status === "completed" || status === "blocked" || status === "manual-review";
}
