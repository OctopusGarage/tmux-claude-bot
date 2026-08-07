import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepositoryReviewQueue,
  type RepositoryReviewQueueItem,
} from "../../src/core/loop/repository-review-queue.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function queue(): RepositoryReviewQueue {
  process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-pr-review-queue-"));
  return new RepositoryReviewQueue();
}

function item(overrides: Partial<RepositoryReviewQueueItem> = {}) {
  return {
    repositoryId: "repo-prs",
    scheduledAt: 100,
    priority: 100,
    now: 100,
    ...overrides,
  };
}

describe("repository review queue", () => {
  it("deduplicates the same repository occurrence and returns it in priority order", () => {
    const store = queue();
    const first = store.enqueue(item({ priority: 10 }));
    const duplicate = store.enqueue(item({ priority: 1 }));
    const urgent = store.enqueue(item({ repositoryId: "urgent", scheduledAt: 101, priority: 20 }));

    expect(duplicate.id).toBe(first.id);
    expect(urgent.status).toBe("pending");
    expect(store.listReady(101).map((entry) => entry.id)).toEqual([urgent.id, first.id]);
  });

  it("reclaims an expired lease and does not lease an item twice", () => {
    const store = queue();
    const created = store.enqueue(item());
    expect(store.lease(created.id, "worker-1", 100, 50)?.leaseOwner).toBe("worker-1");
    expect(store.lease(created.id, "worker-2", 110, 50)).toBeNull();
    expect(store.listReady(151).map((entry) => entry.id)).toEqual([created.id]);
    expect(store.lease(created.id, "worker-2", 151, 50)?.leaseOwner).toBe("worker-2");
  });

  it("retries transient failures with backoff and supports terminal decisions", () => {
    const store = queue();
    const failed = store.enqueue(item({ repositoryId: "retry" }));
    store.lease(failed.id, "worker", 100, 50);
    store.fail(failed.id, "worker", 110, "supervisor unavailable", 200);
    expect(store.listReady(199)).toEqual([]);
    expect(store.listReady(200)).toHaveLength(1);

    const blocked = store.enqueue(item({ repositoryId: "blocked", scheduledAt: 101 }));
    store.lease(blocked.id, "worker", 101, 50);
    store.complete(blocked.id, "worker", 102, "blocked", "requires owner decision");
    expect(store.list({ all: true }).find((entry) => entry.id === blocked.id)).toMatchObject({
      status: "blocked",
      lastError: "requires owner decision",
    });
  });

  it("keeps retryable review work claimable and records explicit manual review separately", () => {
    const store = queue();
    const retry = store.enqueue(item({ repositoryId: "retryable" }));
    store.lease(retry.id, "worker", 100, 50);
    expect(store.retry(retry.id, "worker", 110, "checks still running", 200)).toBe(true);
    expect(store.listReady(199)).toHaveLength(0);
    expect(store.listReady(200)).toHaveLength(1);

    const manual = store.enqueue(item({ repositoryId: "manual", scheduledAt: 101 }));
    store.lease(manual.id, "worker", 101, 50);
    expect(store.manualReview(manual.id, "worker", 102, "migration decision required")).toBe(true);
    expect(store.list({ all: true }).find((entry) => entry.id === manual.id)).toMatchObject({
      status: "manual-review",
      lastError: "migration decision required",
    });
  });
});
