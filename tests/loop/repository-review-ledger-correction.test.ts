import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryReviewQueue } from "../../src/core/loop/repository-review-queue.js";
import { reconcileRepositoryReviewQueueLedgerClosures } from "../../src/core/loop/service.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "tcb-review-ledger-correction-"));
  process.env.TCB_STATE_DIR = stateDir;
  const queue = new RepositoryReviewQueue();
  const ledger = new DailyTaskLedger();
  const item = queue.enqueue({
    repositoryId: "alpha-prs",
    scheduledAt: 100,
    priority: 100,
    now: 100,
  });
  const taskId = "loop:pr-review:alpha-prs:100";
  ledger.expect({ taskId, source: "loop-engineering", name: "Alpha review", scheduledAt: 100 });
  ledger.fail(taskId, { endedAt: 110, error: "dispatch-failed" });
  ledger.markRepairStatus(taskId, { repairStatus: "blocked", updatedAt: 120 });
  expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 200)).toBe(1);
  return { stateDir, queue, ledger, taskId, item: queue.list({ all: true })[0] ?? item };
}

describe("repository review ledger corrections", () => {
  it.each(["pending", "fixed"] as const)(
    "reconciles a newer %s correction across restart",
    (repairStatus) => {
      const { queue, ledger, taskId, item } = fixture();
      ledger.markRepairStatus(taskId, { repairStatus, updatedAt: 300 });
      const execution = ledger.listAll()[0];
      expect(
        reconcileRepositoryReviewQueueLedgerClosures(
          new RepositoryReviewQueue(),
          new DailyTaskLedger(),
          400,
        ),
      ).toBe(1);
      expect(queue.list({ all: true })).toEqual([
        expect.objectContaining({
          id: item.id,
          status: repairStatus === "pending" ? "retry-wait" : "completed",
          attempt: item.attempt,
        }),
      ]);
      expect(ledger.listAll()[0]).toEqual(execution);
      expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 500)).toBe(0);
      expect(queue.listReady(500)).toHaveLength(repairStatus === "pending" ? 1 : 0);
    },
  );

  it.each([
    [199, "pending"],
    [200, "pending"],
    [199, "fixed"],
    [200, "fixed"],
  ] as const)("preserves a block against stale evidence at %i (%s)", (updatedAt, repairStatus) => {
    const { queue, ledger, taskId, item } = fixture();
    ledger.markRepairStatus(taskId, { repairStatus, updatedAt });
    expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 400)).toBe(0);
    expect(queue.list({ all: true })).toEqual([item]);
  });

  it.each(["missing", "wrong-source", "wrong-occurrence"] as const)(
    "requires exact ledger evidence: %s",
    (kind) => {
      const { stateDir, queue, ledger, taskId, item } = fixture();
      const record = ledger.listAll()[0];
      const correction = {
        ...record,
        taskId: kind === "wrong-occurrence" ? `${taskId}0` : taskId,
        source: kind === "wrong-source" ? "external-monitor" : "loop-engineering",
        repairStatus: "pending",
        updatedAt: 300,
      };
      writeFileSync(
        join(stateDir, "scheduled_task_ledger.json"),
        JSON.stringify(kind === "missing" ? {} : { [correction.taskId]: correction }),
      );
      expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 400)).toBe(0);
      expect(queue.list({ all: true })).toEqual([item]);
    },
  );

  it.each(["leased", "running"] as const)(
    "preserves a %s owner while the ledger is pending",
    (status) => {
      const { stateDir, queue, ledger, taskId, item } = fixture();
      const active = { ...item, status, leaseOwner: "worker", leaseUntil: Date.now() + 60_000 };
      writeFileSync(
        join(stateDir, "repository-pr-review-queue.json"),
        JSON.stringify({ [item.id]: active }),
      );
      ledger.markRepairStatus(taskId, { repairStatus: "pending", updatedAt: 300 });
      expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 400)).toBe(0);
      expect(queue.list({ all: true })).toEqual([active]);
    },
  );

  it.each(["blocked", "manual-review", "dead-letter", "completed"] as const)(
    "preserves an independent %s decision",
    (status) => {
      const { stateDir, queue, ledger, taskId, item } = fixture();
      const decision = { ...item, status, lastError: "explicit review decision" };
      writeFileSync(
        join(stateDir, "repository-pr-review-queue.json"),
        JSON.stringify({ [item.id]: decision }),
      );
      ledger.markRepairStatus(taskId, { repairStatus: "pending", updatedAt: 300 });
      expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 400)).toBe(0);
      expect(queue.list({ all: true })).toEqual([decision]);
    },
  );

  it.each([4, 5])("preserves an existing retry budget of %i", (attempt) => {
    const { stateDir, queue, ledger, taskId, item } = fixture();
    const migration = {
      previousStatus: "dead-letter",
      previousAttempt: 5,
      reason: "revalidated",
      migratedAt: 90,
    };
    const budget = { ...item, attempt, retryEpoch: 1, migration, nextAttemptAt: 900 };
    writeFileSync(
      join(stateDir, "repository-pr-review-queue.json"),
      JSON.stringify({ [item.id]: budget }),
    );
    ledger.markRepairStatus(taskId, { repairStatus: "pending", updatedAt: 300 });
    expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 400)).toBe(1);
    expect(queue.list({ all: true })).toEqual([
      expect.objectContaining({
        id: item.id,
        attempt,
        retryEpoch: 1,
        migration,
        status: attempt === 5 ? "dead-letter" : "retry-wait",
      }),
    ]);
    expect(queue.listReady(500)).toEqual([]);
    expect(queue.listReady(900)).toHaveLength(attempt === 5 ? 0 : 1);
  });
});
