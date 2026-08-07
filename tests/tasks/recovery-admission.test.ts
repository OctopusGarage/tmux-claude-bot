import { describe, expect, it, vi } from "vitest";
import {
  admitRecoveryFindings,
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
});
