import { describe, expect, it, vi } from "vitest";
import type { LoopSupervisorWorkOrderRegistry } from "../../../src/core/loop/supervisor-state.js";
import { discoverRuntimeGuardianFindings } from "../../../src/core/runtime-guardian/inspector.js";

const mocks = vi.hoisted(() => ({
  readLoopSupervisorWorkOrderRegistry: vi.fn(),
  listAll: vi.fn(),
}));

vi.mock("../../../src/core/loop/supervisor-state.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../src/core/loop/supervisor-state.js")>();
  return {
    ...original,
    readLoopSupervisorWorkOrderRegistry: mocks.readLoopSupervisorWorkOrderRegistry,
  };
});

vi.mock("../../../src/core/loop/supervisor-pool.js", () => ({
  readLoopSupervisorWorkerLeaseState: () => ({ leases: [] }),
}));

vi.mock("../../../src/core/tasks/task-ledger.js", () => ({
  DailyTaskLedger: class {
    listAll = mocks.listAll;
  },
}));

vi.mock("../../../src/core/tasks/repair-coordinator.js", () => ({
  RepairCoordinator: class {
    list() {
      return [];
    }
  },
}));

function terminalRecord(id: string, updatedAt: number) {
  type TerminalRecord = LoopSupervisorWorkOrderRegistry["terminal"][number];
  return {
    runDir: `/synthetic/runs/${id}`,
    workOrder: {
      id,
      projectId: "alpha",
      projectName: "Alpha",
      projectPath: "/synthetic/alpha",
      scheduledAt: updatedAt - 1_000,
      requiredFinalMarker: "FINAL",
    } as TerminalRecord["workOrder"],
    state: {
      status: "completed" as const,
      projectId: "alpha",
      runId: id,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      scheduledAt: updatedAt - 1_000,
      updatedAt,
    },
  } satisfies TerminalRecord;
}

describe("discoverRuntimeGuardianFindings", () => {
  it("reuses one WorkOrder registry and one task-ledger snapshot per observation", () => {
    const now = Date.parse("2026-08-24T20:00:00Z");
    const registry: LoopSupervisorWorkOrderRegistry = {
      records: [],
      unfinished: [],
      recoverableFinalSummary: [],
      recoverableFailed: [],
      abandoned: [],
      staleDispatching: [],
      terminal: [terminalRecord("run-1", now), terminalRecord("run-2", now)],
    };
    mocks.readLoopSupervisorWorkOrderRegistry.mockReturnValue(registry);
    mocks.listAll.mockReturnValue([]);

    const findings = discoverRuntimeGuardianFindings({
      now,
      lookbackMs: 60 * 60 * 1_000,
    });

    expect(findings).toEqual([]);
    expect(mocks.readLoopSupervisorWorkOrderRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.readLoopSupervisorWorkOrderRegistry).toHaveBeenCalledWith(now);
    expect(mocks.listAll).toHaveBeenCalledTimes(1);
  });
});
