import { describe, expect, it, vi } from "vitest";
import { runProjectRecoveryPass } from "../../src/core/tasks/project-recovery-service.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";

describe("project recovery dispatch deferral", () => {
  it("reopens the ledger record when supervisor capacity blocks dispatch", async () => {
    const updateRepairStatus = vi.fn();
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:alcove:architecture:1000",
          source: "loop-engineering",
          name: "alcove architecture",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "alcove", name: "Alcove", path: "/repo/alcove" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch: async () => ({
        status: "blocked",
        detail: "project already has active automation",
      }),
      canonicalize: (path) => path,
    });
    expect(result).toMatchObject({ enqueued: 1, dispatched: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:alcove:architecture:1000",
      "pending",
      expect.stringContaining("dispatch deferred"),
    );
    expect(coordinator.list()[0]).toMatchObject({
      status: "pending",
      nextAttemptAt: 2_000,
    });
  });
});
