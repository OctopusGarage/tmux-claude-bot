import { describe, expect, it } from "vitest";
import {
  allocateLoopSupervisorBatches,
  consumeExpiredRetainedSupervisorWorkerLeases,
  leaseLoopSupervisorWorker,
  releaseLoopSupervisorWorker,
} from "../../src/core/loop/supervisor-pool.js";

describe("allocateLoopSupervisorBatches", () => {
  it("fills supervisor slots while keeping the same project path out of the same batch", () => {
    const batches = allocateLoopSupervisorBatches(
      [
        { id: "a", projectPath: "/repo/a" },
        { id: "a-review", projectPath: "/repo/a" },
        { id: "b", projectPath: "/repo/b" },
        { id: "c", projectPath: "/repo/c" },
      ],
      ["supervisor-1", "supervisor-2"],
    );

    expect(batches.map((batch) => batch.map((entry) => entry.item.id))).toEqual([
      ["a", "b"],
      ["a-review", "c"],
    ]);
    expect(batches[0]?.map((entry) => entry.supervisorSession)).toEqual([
      "supervisor-1",
      "supervisor-2",
    ]);
  });
});

describe("loop supervisor worker leases", () => {
  const workOrder = {
    id: "run-1",
    projectId: "app",
    projectPath: "/repo/app",
  };

  it("leases one available supervisor worker and blocks conflicting reuse", () => {
    const first = leaseLoopSupervisorWorker({
      state: { leases: [] },
      supervisorSession: "loop-supervisor-1",
      workOrder,
      now: 1000,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });

    expect(first.status).toBe("leased");
    if (first.status !== "leased") throw new Error("expected lease");
    expect(first.lease).toMatchObject({
      workerSession: "loop-supervisor-1",
      workOrderId: "run-1",
      projectId: "app",
      projectPath: "/repo/app",
      status: "active",
    });

    const second = leaseLoopSupervisorWorker({
      state: first.state,
      supervisorSession: "loop-supervisor-1",
      workOrder: { id: "run-2", projectId: "other", projectPath: "/repo/other" },
      now: 1001,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });

    expect(second).toMatchObject({
      status: "unavailable",
      reason: "worker loop-supervisor-1 is leased by run-1",
    });
  });

  it("releases successful work and retains failed work until ttl expires", () => {
    const leased = leaseLoopSupervisorWorker({
      state: { leases: [] },
      supervisorSession: "loop-supervisor-1",
      workOrder,
      now: 1000,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });
    if (leased.status !== "leased") throw new Error("expected lease");

    const released = releaseLoopSupervisorWorker({
      state: leased.state,
      workOrderId: "run-1",
      result: "success",
      now: 2000,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });
    expect(released.leases).toEqual([]);

    const failedLease = leaseLoopSupervisorWorker({
      state: released,
      supervisorSession: "loop-supervisor-1",
      workOrder,
      now: 3000,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });
    if (failedLease.status !== "leased") throw new Error("expected failed lease setup");

    const retained = releaseLoopSupervisorWorker({
      state: failedLease.state,
      workOrderId: "run-1",
      result: "failure",
      now: 4000,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });

    expect(retained.leases).toMatchObject([
      {
        workerSession: "loop-supervisor-1",
        workOrderId: "run-1",
        status: "retained",
        retainUntil: 4000 + 72 * 60 * 60 * 1000,
      },
    ]);

    const replaced = leaseLoopSupervisorWorker({
      state: retained,
      supervisorSession: "loop-supervisor-1",
      workOrder: { id: "run-2", projectId: "other", projectPath: "/repo/other" },
      now: 5000,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });
    expect(replaced).toMatchObject({
      status: "leased",
      lease: {
        workerSession: "loop-supervisor-1",
        workOrderId: "run-2",
        status: "active",
      },
    });
    if (replaced.status !== "leased") throw new Error("expected retained lease replacement");
    expect(replaced.state.leases).toHaveLength(1);
    expect(replaced.state.leases[0]?.workOrderId).toBe("run-2");

    const afterTtl = leaseLoopSupervisorWorker({
      state: retained,
      supervisorSession: "loop-supervisor-1",
      workOrder: { id: "run-2", projectId: "other", projectPath: "/repo/other" },
      now: 4000 + 72 * 60 * 60 * 1000 + 1,
      retainFailureForMs: 72 * 60 * 60 * 1000,
    });
    expect(afterTtl.status).toBe("leased");
  });

  it("returns expired retained leases for external tmux cleanup", () => {
    const result = consumeExpiredRetainedSupervisorWorkerLeases(
      {
        leases: [
          {
            workerSession: "loop-supervisor-1",
            workOrderId: "active",
            projectId: "app",
            projectPath: "/repo/app",
            status: "active",
            leasedAt: 1000,
            updatedAt: 1000,
          },
          {
            workerSession: "loop-supervisor-2",
            workOrderId: "expired",
            projectId: "app",
            projectPath: "/repo/app",
            status: "retained",
            leasedAt: 1000,
            updatedAt: 2000,
            retainUntil: 3000,
          },
          {
            workerSession: "loop-supervisor-3",
            workOrderId: "retained",
            projectId: "app",
            projectPath: "/repo/app",
            status: "retained",
            leasedAt: 1000,
            updatedAt: 2000,
            retainUntil: 5000,
          },
        ],
      },
      3001,
    );

    expect(result.expired.map((lease) => lease.workerSession)).toEqual(["loop-supervisor-2"]);
    expect(result.state.leases.map((lease) => lease.workerSession)).toEqual([
      "loop-supervisor-1",
      "loop-supervisor-3",
    ]);
  });
});
