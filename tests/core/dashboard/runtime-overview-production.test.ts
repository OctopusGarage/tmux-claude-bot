import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { DailyTaskLedger } from "../../../src/core/tasks/task-ledger.js";

const registryRead = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/loop/supervisor-state.js", () => ({
  readLoopSupervisorWorkOrderRegistry: registryRead,
}));

import { createRuntimeOverviewReaders } from "../../../src/core/dashboard/runtime-overview-production.js";

function emptyRegistry() {
  return {
    records: [],
    unfinished: [],
    terminal: [],
    abandoned: [],
    staleDispatching: [],
  };
}

describe("production Runtime Overview readers", () => {
  it("keeps synchronous artifact scans out of the two-second TUI refresh path", () => {
    registryRead.mockReset();
    registryRead.mockReturnValue(emptyRegistry());
    const deps = {} as HandlerDeps;

    createRuntimeOverviewReaders({ deps, now: 1_000, operatorSessionRunning: false }).workOrders();
    createRuntimeOverviewReaders({ deps, now: 3_000, operatorSessionRunning: false }).workOrders();
    createRuntimeOverviewReaders({ deps, now: 30_999, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(1);

    createRuntimeOverviewReaders({ deps, now: 31_000, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(2);

    createRuntimeOverviewReaders({ deps, now: 500, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(3);
  });

  it("keeps Agent Capacity visible for Autopilot when no Loop config file is configured", () => {
    const deps = {
      config: {
        loopEngineering: {
          configFile: "",
          supervisor: { enabled: true, agent: "codex" },
        },
      },
      ownerActivity: { lastObservedAt: () => null },
    } as HandlerDeps;

    expect(
      createRuntimeOverviewReaders({
        deps,
        now: 1_000,
        operatorSessionRunning: false,
      }).agentCapacity?.(),
    ).toMatchObject({ enabled: true, agent: "codex" });
  });

  it("attaches closed ledger repair status to terminal WorkOrders", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = 10_000;
      const id = "run-closed";
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: `autopilot:${id}`,
        source: "autopilot-delegate",
        name: "tmux-claude-bot active delegated task",
        scheduledAt: now - 2_000,
      });
      ledger.fail(`autopilot:${id}`, {
        endedAt: now - 1_000,
        error: "active delegation ended with blocked",
      });
      ledger.markRepairStatus(`autopilot:${id}`, {
        repairStatus: "superseded",
        updatedAt: now - 500,
      });

      registryRead.mockReset();
      registryRead.mockReturnValue({
        ...emptyRegistry(),
        records: [
          {
            workOrder: {
              id,
              projectId: "tmux-claude-bot",
              projectName: "tmux-claude-bot",
              projectPath: "/tmp/project",
              scheduledAt: now - 2_000,
              requiredFinalMarker: "FINAL",
              task: { kind: "active-delegated-task" },
            },
            state: {
              status: "failed",
              projectId: "tmux-claude-bot",
              runId: id,
              supervisorSession: "tmux_proj_loop-supervisor-1",
              scheduledAt: now - 2_000,
              updatedAt: now - 1_000,
            },
            runDir: "/tmp/run",
          },
        ],
        terminal: [
          {
            workOrder: {
              id,
              projectId: "tmux-claude-bot",
              projectName: "tmux-claude-bot",
              projectPath: "/tmp/project",
              scheduledAt: now - 2_000,
              requiredFinalMarker: "FINAL",
              task: { kind: "active-delegated-task" },
            },
            state: {
              status: "failed",
              projectId: "tmux-claude-bot",
              runId: id,
              supervisorSession: "tmux_proj_loop-supervisor-1",
              scheduledAt: now - 2_000,
              updatedAt: now - 1_000,
            },
            runDir: "/tmp/run",
          },
        ],
      });

      const result = await createRuntimeOverviewReaders({
        deps: {} as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).workOrders();

      expect(result.terminal).toEqual([
        expect.objectContaining({
          id,
          repairStatus: "superseded",
        }),
      ]);
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
