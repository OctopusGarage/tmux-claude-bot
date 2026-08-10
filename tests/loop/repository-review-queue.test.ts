import { mkdtempSync, writeFileSync } from "node:fs";
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
  it("migrates legacy blocked records without decision evidence back to retryable", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-pr-review-queue-"));
    process.env.TCB_STATE_DIR = stateDir;
    writeFileSync(
      join(stateDir, "repository-pr-review-queue.json"),
      JSON.stringify({
        legacy: {
          id: "legacy",
          repositoryId: "repo-prs",
          scheduledAt: 100,
          priority: 100,
          status: "blocked",
          attempt: 1,
          createdAt: 100,
          updatedAt: 110,
          nextAttemptAt: 100,
        },
      }),
    );

    const store = new RepositoryReviewQueue();

    expect(store.listReady(200)).toEqual([
      expect.objectContaining({
        id: "legacy",
        status: "retry-wait",
        nextAttemptAt: 200,
        lastError: "migrated legacy blocked repository review",
      }),
    ]);
  });

  it("does not migrate blocked records that contain an explicit decision reason", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-pr-review-queue-"));
    process.env.TCB_STATE_DIR = stateDir;
    writeFileSync(
      join(stateDir, "repository-pr-review-queue.json"),
      JSON.stringify({
        blocked: {
          id: "blocked",
          repositoryId: "repo-prs",
          scheduledAt: 100,
          priority: 100,
          status: "blocked",
          attempt: 1,
          createdAt: 100,
          updatedAt: 110,
          nextAttemptAt: 100,
          lastError: "requires owner decision",
        },
      }),
    );

    const store = new RepositoryReviewQueue();

    expect(store.listReady(200)).toEqual([]);
    expect(store.list({ all: true })).toEqual([
      expect.objectContaining({ id: "blocked", status: "blocked" }),
    ]);
  });

  it("deduplicates the same repository occurrence and returns it in priority order", () => {
    const store = queue();
    const first = store.enqueue(item({ priority: 10 }));
    const duplicate = store.enqueue(item({ priority: 1 }));
    const urgent = store.enqueue(item({ repositoryId: "urgent", scheduledAt: 101, priority: 20 }));

    expect(duplicate.id).toBe(first.id);
    expect(urgent.status).toBe("pending");
    expect(store.listReady(101).map((entry) => entry.id)).toEqual([urgent.id, first.id]);
  });

  it("sorts equal-priority occurrences by creation time and id", () => {
    const store = queue();
    const first = store.enqueue(item({ repositoryId: "same-a", priority: 10 }));
    const second = store.enqueue(item({ repositoryId: "same-b", priority: 10 }));

    expect(store.listReady(100).map((entry) => entry.id)).toEqual([first.id, second.id].sort());
  });

  it("reclaims an expired lease and does not lease an item twice", () => {
    const store = queue();
    const created = store.enqueue(item());
    expect(store.lease(created.id, "worker-1", 100, 50)?.leaseOwner).toBe("worker-1");
    expect(store.lease(created.id, "worker-2", 110, 50)).toBeNull();
    expect(store.listReady(151).map((entry) => entry.id)).toEqual([created.id]);
    expect(store.lease(created.id, "worker-2", 151, 50)?.leaseOwner).toBe("worker-2");
  });

  it("reclaims a lease owned by a process that exited before its long lease expires", () => {
    const store = queue();
    const created = store.enqueue(item());

    expect(store.lease(created.id, "99999999:worker-1", 100, 86_400_000)).not.toBeNull();

    expect(store.listReady(101)).toEqual([
      expect.objectContaining({ id: created.id, status: "pending" }),
    ]);
  });

  it("adopts a pending occurrence when its supervisor work order survived a restart", () => {
    const store = queue();
    const created = store.enqueue(item({ repositoryId: "restartable" }));

    expect(
      store.adoptRunning(
        "restartable",
        100,
        `${process.pid}:tmux_proj_loop-supervisor-4`,
        200,
        1_000,
        true,
      ),
    ).toMatchObject({
      id: created.id,
      status: "running",
      leaseOwner: `${process.pid}:tmux_proj_loop-supervisor-4`,
      attempt: 1,
    });
    expect(store.listReady(200)).toEqual([]);
  });

  it("does not mark a recovered occurrence running without its matching active worker lease", () => {
    const store = queue();
    const created = store.enqueue(item({ repositoryId: "unleased-restart" }));

    expect(
      store.adoptRunning(
        "unleased-restart",
        100,
        `${process.pid}:tmux_proj_loop-supervisor-4`,
        200,
        1_000,
        false,
      ),
    ).toBeNull();
    expect(store.listReady(200)).toEqual([
      expect.objectContaining({ id: created.id, status: "pending" }),
    ]);
  });

  it("requeues an occurrence when its supervisor work order ended in a retryable failure", () => {
    const store = queue();
    const created = store.enqueue(item({ repositoryId: "failed-after-restart" }));

    expect(
      store.retryOccurrence(
        "failed-after-restart",
        100,
        200,
        "supervisor work order ended with invalid output",
        200,
      ),
    ).toBe(true);
    expect(store.listReady(200)).toEqual([
      expect.objectContaining({
        id: created.id,
        status: "retry-wait",
        nextAttemptAt: 200,
        lastError: "supervisor work order ended with invalid output",
      }),
    ]);
  });

  it("does not repeatedly requeue the same terminal work order on every tick", () => {
    const store = queue();
    store.enqueue(item({ repositoryId: "reconcile-once" }));

    expect(
      store.retryOccurrence(
        "reconcile-once",
        100,
        200,
        "recovered supervisor work order result: dispatch-failed",
        500,
      ),
    ).toBe(true);
    expect(
      store.retryOccurrence(
        "reconcile-once",
        100,
        300,
        "recovered supervisor work order result: dispatch-failed",
        300,
      ),
    ).toBe(false);
    expect(store.list({ all: true })[0]).toMatchObject({
      status: "retry-wait",
      nextAttemptAt: 500,
      updatedAt: 200,
    });
    expect(store.listReady(499)).toEqual([]);
    expect(store.listReady(500)).toHaveLength(1);
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

  it("dead-letters an occurrence after the bounded infrastructure retry budget", () => {
    const store = queue();
    const created = store.enqueue(item({ repositoryId: "persistent-failure" }));
    let now = 100;
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(store.lease(created.id, "worker", now, 50)).not.toBeNull();
      expect(store.fail(created.id, "worker", now + 1, "worker setup failed", now + 2)).toBe(true);
      now += 100;
    }

    expect(store.list({ all: true }).find((entry) => entry.id === created.id)).toMatchObject({
      status: "dead-letter",
      attempt: 5,
      lastError: "worker setup failed",
    });
    expect(store.listReady(now + 1_000)).toEqual([]);
  });

  it("dead-letters a legacy over-budget retry before another worker can lease it", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-pr-review-queue-"));
    process.env.TCB_STATE_DIR = stateDir;
    writeFileSync(
      join(stateDir, "repository-pr-review-queue.json"),
      JSON.stringify({
        legacy: {
          id: "legacy",
          repositoryId: "repo-prs",
          scheduledAt: 100,
          priority: 100,
          status: "retry-wait",
          attempt: 107,
          createdAt: 100,
          updatedAt: 110,
          nextAttemptAt: 100,
          lastError: "recovered supervisor work order result: blocked",
        },
      }),
    );
    const store = new RepositoryReviewQueue();

    expect(store.listReady(200)).toEqual([]);
    expect(store.list({ all: true })).toEqual([
      expect.objectContaining({ id: "legacy", status: "dead-letter", attempt: 107 }),
    ]);
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
