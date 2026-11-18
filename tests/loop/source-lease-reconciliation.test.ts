import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quarantineLoopExecution } from "../../src/core/loop/execution-quarantine.js";
import {
  type LoopSupervisorWorkerLease,
  readLoopSupervisorWorkerLeaseState,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import { reconcileTerminalSupervisorResources } from "../../src/core/loop/supervisor-resource-reconciliation.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const previousState = process.env.TCB_STATE_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  if (previousState === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = previousState;
});

function fixture(status: "failed" | "in-flight" = "failed") {
  vi.spyOn(Date, "now").mockReturnValue(2_000);
  const root = mkdtempSync(join(tmpdir(), "tcb-source-lease-"));
  process.env.TCB_STATE_DIR = join(root, "state");
  const source = join(root, "caller-owned-source");
  mkdirSync(source);
  writeFileSync(join(source, "partial.txt"), "Preserve incomplete implementation.\n");
  const order = {
    id: "source-run",
    projectId: "source-project",
    projectName: "Source project",
    projectPath: source,
    agent: "codex",
    scheduledAt: 1_000,
    workerSession: "tmux_proj_loop-worker-source-run",
    finalSummaryPath: join(
      root,
      "state",
      "loop-runs",
      "source-project",
      "source-run",
      "summary.json",
    ),
    requiredFinalMarker: "[DONE:source-run]",
    commitPolicy: { enabled: false, perRound: false },
    executionIsolation: {
      mode: "supervised-worker",
      expectedWorktree: source,
      preparedBy: "source-worktree",
      worktreeIsolation: "source",
      contextReset: "compact",
      cleanup: { success: "release-worker", failure: "retain-for-ttl", retainFailureForHours: 0 },
    },
  } as LoopWorkOrder;
  writeLoopSupervisorWorkOrderState({
    workOrder: order,
    supervisorSession: "tmux_proj_loop-supervisor-1",
    status,
    now: 2_000,
    ...(status === "failed" ? { resultStatus: "dispatch-failed" as const } : {}),
  });
  const lease: LoopSupervisorWorkerLease = {
    workerSession: "tmux_proj_loop-supervisor-1",
    workOrderId: order.id,
    projectId: order.projectId,
    projectPath: source,
    status: "retained",
    leasedAt: 1_000,
    updatedAt: 2_000,
    retainUntil: 2_000,
  };
  writeLoopSupervisorWorkerLeaseState({ leases: [lease] });
  return { order, lease, source };
}

describe("terminal source-mode lease reconciliation", () => {
  it.each([false, true])(
    "releases an expired source lease without deleting source or killing a shared supervisor (Git: %s)",
    async (withGit) => {
      const f = fixture();
      const runGit = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
      const cleanupWorkerSession = vi.fn();
      const result = await reconcileTerminalSupervisorResources({
        now: 2_000,
        ...(withGit ? { runGit } : {}),
        cleanupWorkerSession,
        workerSessionExists: () => false,
      });
      expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([]);
      expect(result).toMatchObject({ removedStaleLeases: 1, removedExpiredWorktrees: 0 });
      expect(readFileSync(join(f.source, "partial.txt"), "utf8")).toBe(
        "Preserve incomplete implementation.\n",
      );
      expect(runGit).not.toHaveBeenCalled();
      expect(cleanupWorkerSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    "not-expired",
    "nonterminal",
    "excluded",
    "quarantined",
    "wrong-project",
    "wrong-path",
    "wrong-session",
  ])("retains source lease when %s", async (reason) => {
    const f = fixture(reason === "nonterminal" ? "in-flight" : "failed");
    const lease = {
      ...f.lease,
      ...(reason === "not-expired" ? { retainUntil: 3_000 } : {}),
      ...(reason === "wrong-project" ? { projectId: "other-project" } : {}),
      ...(reason === "wrong-path" ? { projectPath: join(f.source, "other") } : {}),
      ...(reason === "wrong-session" ? { workerSession: "another-supervisor" } : {}),
    };
    writeLoopSupervisorWorkerLeaseState({ leases: [lease] });
    if (reason === "quarantined") quarantineLoopExecution(f.order, "Process ownership uncertain");
    await reconcileTerminalSupervisorResources({
      now: 2_001,
      ...(reason === "excluded" ? { excludedWorkOrderIds: new Set([f.order.id]) } : {}),
    });
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([lease]);
    expect(existsSync(f.source)).toBe(true);
  });

  it.each(["busy", "probe-error"])(
    "preserves a source lease while its worker is %s",
    async (reason) => {
      const f = fixture();
      const ownsTurn = vi.fn(async () => {
        if (reason === "probe-error") throw new Error("Ownership unavailable");
        return true;
      });
      const cleanup = vi.fn();
      await reconcileTerminalSupervisorResources({
        now: 2_001,
        workerSessionExists: () => true,
        workerSessionOwnsActiveTurn: ownsTurn,
        cleanupWorkerSession: cleanup,
      });
      expect(ownsTurn).toHaveBeenCalledWith({
        workerSession: f.order.workerSession,
        workOrder: expect.objectContaining({ id: f.order.id }),
      });
      expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([f.lease]);
      expect(cleanup).not.toHaveBeenCalled();
    },
  );

  it("preserves a replacement active lease acquired during the ownership probe", async () => {
    const f = fixture();
    const replacement = { ...f.lease, workOrderId: "replacement", status: "active" as const };
    await reconcileTerminalSupervisorResources({
      now: 2_001,
      workerSessionExists: () => true,
      workerSessionOwnsActiveTurn: async () => {
        writeLoopSupervisorWorkerLeaseState({ leases: [replacement] });
        return false;
      },
    });
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([replacement]);
  });

  it("releases only the matching source lease and preserves unrelated retained records", async () => {
    const f = fixture();
    const unrelated = {
      ...f.lease,
      workOrderId: "unrelated",
      projectId: "another-project",
      projectPath: join(f.source, "..", "another-source"),
      workerSession: "another-supervisor",
    };
    writeLoopSupervisorWorkerLeaseState({ leases: [f.lease, unrelated] });
    await reconcileTerminalSupervisorResources({ now: 2_001 });
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([unrelated]);
  });
});
