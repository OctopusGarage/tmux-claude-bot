import { describe, expect, it, vi } from "vitest";
import {
  admitRecoveryFindings,
  dispatchRecoveryQueue,
  type RecoveryFinding,
} from "../../src/core/tasks/recovery-admission.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";

function finding(overrides: Partial<RecoveryFinding> = {}): RecoveryFinding {
  return {
    projectId: "bot",
    projectPath: "/repo/bot",
    source: "daily-audit",
    taskFamily: "scheduled-task",
    fingerprint: "run-1",
    taskId: "run-1",
    summary: "failed scheduled task",
    priority: 100,
    ...overrides,
  };
}

describe("recovery admission", () => {
  it("claims and delegates a structured finding through one interface", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const dispatch = vi.fn(async () => ({ status: "queued" as const, detail: "run-2" }));

    const result = await admitRecoveryFindings({
      findings: [finding()],
      coordinator,
      now: 1_000,
      leaseId: "admission:1",
      dispatch,
    });

    expect(result).toMatchObject({ disposition: "queued", admitted: 1, claimed: 1 });
    expect(dispatch).toHaveBeenCalledWith([expect.objectContaining({ linkedTaskIds: ["run-1"] })]);
    expect(coordinator.list()).toEqual([expect.objectContaining({ status: "running" })]);
  });

  it("claims the new active record when an equivalent historical repair is terminal", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const historical = coordinator.enqueue({ ...finding(), now: 1 });
    coordinator.markTerminal(historical.id, "superseded", 2);
    const dispatch = vi.fn(async () => ({ status: "queued" as const, detail: "run-2" }));

    const result = await admitRecoveryFindings({
      findings: [finding()],
      coordinator,
      now: 3,
      leaseId: "admission:retry",
      dispatch,
    });

    expect(result).toMatchObject({ disposition: "queued", admitted: 1, claimed: 1 });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(coordinator.list()).toEqual([
      expect.objectContaining({ id: historical.id, status: "superseded" }),
      expect.objectContaining({ status: "running", linkedTaskIds: ["run-1"] }),
    ]);
  });

  it("claims an active runtime repair by task identity after evidence formatting changes", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const existing = coordinator.enqueue({
      ...finding({
        source: "runtime-guardian",
        fingerprint: "gate failed | artifact exists",
        taskId: "runtime-run-1",
      }),
      now: 1,
    });
    const dispatch = vi.fn(async () => ({ status: "queued" as const, detail: "run-2" }));

    const result = await admitRecoveryFindings({
      findings: [
        finding({
          source: "runtime-guardian",
          fingerprint: "gate failed; artifact exists",
          taskId: "runtime-run-1",
        }),
      ],
      coordinator,
      now: 2,
      leaseId: "admission:runtime",
      dispatch,
    });

    expect(result).toMatchObject({ disposition: "queued", admitted: 1, claimed: 1 });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(coordinator.list()).toEqual([
      expect.objectContaining({ id: existing.id, status: "running" }),
    ]);
  });

  it("returns an immediate capacity deferral to the queue without incrementing retry", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());

    const result = await admitRecoveryFindings({
      findings: [finding()],
      coordinator,
      now: 1_000,
      leaseId: "admission:1",
      dispatch: async () => ({ status: "blocked", detail: "supervisor queue full" }),
    });

    expect(result).toMatchObject({ disposition: "deferred", admitted: 1, claimed: 1 });
    expect(coordinator.list()).toEqual([
      expect.objectContaining({ status: "pending", attempt: 0, nextAttemptAt: 1_000 }),
    ]);
  });

  it("returns a normal blocked admission to backoff retry", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const result = await admitRecoveryFindings({
      findings: [finding()],
      coordinator,
      now: 1_000,
      leaseId: "admission:1",
      dispatch: async () => ({ status: "blocked", detail: "repair failed" }),
    });
    expect(result.disposition).toBe("blocked");
    expect(coordinator.list()[0]).toMatchObject({ status: "retry-wait", attempt: 1 });
  });

  it("does nothing for an empty admission", async () => {
    const result = await admitRecoveryFindings({
      findings: [],
      coordinator: new RepairCoordinator(new InMemoryRepairQueueStore()),
      now: 1,
      leaseId: "x",
      dispatch: async () => ({ status: "queued", detail: "unused" }),
    });
    expect(result).toMatchObject({ disposition: "not-needed", admitted: 0 });
  });

  it("records known external blockers as a durable terminal state without dispatching", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const dispatch = vi.fn(async () => ({ status: "queued" as const, detail: "unused" }));
    const result = await admitRecoveryFindings({
      findings: [finding({ terminalStatus: "blocked" })],
      coordinator,
      now: 1_000,
      leaseId: "admission:1",
      dispatch,
    });

    expect(result).toMatchObject({ disposition: "blocked", admitted: 1, claimed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.list()).toEqual([expect.objectContaining({ status: "blocked" })]);
  });

  it("terminalizes a queue claim without resolvable ledger items", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({ ...finding(), now: 1 });
    const result = await dispatchRecoveryQueue({
      coordinator,
      now: 2,
      leaseId: "x",
      projectId: "bot",
      limit: 1,
      resolve: () => [],
      dispatch: async () => ({ status: "queued", detail: "unused" }),
      onQueued: () => {},
    });
    expect(result).toMatchObject({ disposition: "blocked", detail: "no ledger evidence" });
    expect(coordinator.list()[0]).toMatchObject({ status: "blocked" });
  });

  it("returns a dispatch exception to retry wait", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({ ...finding(), now: 1 });
    const result = await dispatchRecoveryQueue({
      coordinator,
      now: 2,
      leaseId: "x",
      projectId: "bot",
      limit: 1,
      resolve: () => ["item"],
      dispatch: async () => {
        throw new Error("offline");
      },
      onQueued: () => {},
    });
    expect(result).toMatchObject({ disposition: "blocked", detail: "dispatch failed" });
    expect(coordinator.list()[0]).toMatchObject({ status: "retry-wait" });
  });
});
