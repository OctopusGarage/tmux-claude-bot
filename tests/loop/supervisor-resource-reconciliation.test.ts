import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLoopSupervisorWorkerLeaseState,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import { reconcileTerminalSupervisorResources } from "../../src/core/loop/supervisor-resource-reconciliation.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function workOrder(stateDir: string, overrides: Partial<LoopWorkOrder> = {}): LoopWorkOrder {
  const id = overrides.id ?? "run-1";
  return {
    id,
    projectId: "app",
    projectName: "App",
    projectPath: overrides.projectPath ?? join(stateDir, "loop-worktrees", "app", id),
    agent: "codex",
    scheduledAt: 1_000,
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${id}]`,
    finalSummaryPath: join(stateDir, "loop-runs", "app", id, "supervisor-final-summary.json"),
    commitPolicy: { enabled: false, perRound: false },
    ...overrides,
  } as LoopWorkOrder;
}

describe("supervisor resource reconciliation", () => {
  it("returns an empty reconciliation summary when no supervisor resources are terminal", async () => {
    await expect(reconcileTerminalSupervisorResources({ now: 2_000 })).resolves.toEqual({
      settledTerminalLeases: 0,
      abandonedWorkOrders: 0,
      removedTerminalWorktrees: 0,
      removedExpiredWorktrees: 0,
      removedOrphanWorktrees: 0,
      removedStaleLeases: 0,
      cleanedTerminalWorkerSessions: 0,
    });
  });

  it("removes worker leases whose worktree has already disappeared", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-supervisor-resource-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const existingPath = mkdtempSync(join(tmpdir(), "tcb-supervisor-resource-existing-"));
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-worker-missing",
          workOrderId: "missing-run",
          projectId: "missing",
          projectPath: join(stateDir, "loop-worktrees", "missing", "missing-run"),
          status: "active",
          leasedAt: 1_000,
          updatedAt: 1_000,
        },
        {
          workerSession: "tmux_proj_loop-worker-existing",
          workOrderId: "existing-run",
          projectId: "existing",
          projectPath: existingPath,
          status: "retained",
          leasedAt: 1_000,
          updatedAt: 1_000,
          retainUntil: 10_000,
        },
      ],
    });

    await expect(reconcileTerminalSupervisorResources({ now: 2_000 })).resolves.toMatchObject({
      removedStaleLeases: 1,
    });

    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([
      expect.objectContaining({ workOrderId: "existing-run" }),
    ]);
  });

  it("cleans terminal worker sessions even when the WorkOrder failed", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-supervisor-resource-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const order = workOrder(stateDir, {
      id: "failed-run",
      workerSession: "tmux_proj_loop-worker-app-failed-run",
    } as Partial<LoopWorkOrder>);
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "supervisor-failed",
      now: 2_000,
    });
    const cleanupWorkerSession = vi.fn(async () => undefined);

    await expect(
      reconcileTerminalSupervisorResources({
        now: 3_000,
        cleanupWorkerSession,
        workerSessionExists: async () => true,
      }),
    ).resolves.toMatchObject({
      cleanedTerminalWorkerSessions: 1,
    });

    expect(cleanupWorkerSession).toHaveBeenCalledWith("tmux_proj_loop-worker-app-failed-run");
    expect(existsSync(order.projectPath)).toBe(false);
  });

  it("reconciles stale Git metadata when a terminal worktree directory already disappeared", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-supervisor-resource-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const sourceWorktree = mkdtempSync(join(tmpdir(), "tcb-supervisor-resource-source-"));
    const missingOrder = (id: string) =>
      workOrder(stateDir, {
        id,
        executionIsolation: {
          mode: "supervised-worker",
          expectedWorktree: join(stateDir, "loop-worktrees", "app", id),
          sourceWorktree,
          worktreeIsolation: "isolated",
          preparedBy: "system-git-worktree",
          contextReset: "compact",
          cleanup: {
            success: "release-worker",
            failure: "retain-for-ttl",
            retainFailureForHours: 72,
          },
        },
      });
    const orders = [missingOrder("missing-worktree-run-1"), missingOrder("missing-worktree-run-2")];
    for (const order of orders) {
      writeLoopSupervisorWorkOrderState({
        workOrder: order,
        supervisorSession: "tmux_proj_loop-supervisor-1",
        status: "completed",
        resultStatus: "completed",
        now: 2_000,
      });
    }
    const calls: string[] = [];

    const reconcile = () =>
      reconcileTerminalSupervisorResources({
        now: 3_000,
        runGit: (invocation) => {
          calls.push(`${invocation.cwd}:${invocation.args.join(" ")}`);
          if (invocation.args[0] === "rev-parse") {
            return { status: 0, stdout: `${sourceWorktree}\n`, stderr: "" };
          }
          if (invocation.args.join(" ") === "worktree list --porcelain") {
            return {
              status: 0,
              stdout: orders
                .map((order) => `worktree ${order.projectPath}\nprunable stale\n`)
                .join("\n"),
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });

    await expect(reconcile()).resolves.toMatchObject({ removedTerminalWorktrees: 2 });
    await expect(reconcile()).resolves.toMatchObject({ removedTerminalWorktrees: 0 });
    expect(calls).toEqual([
      `${sourceWorktree}:rev-parse --show-toplevel`,
      `${sourceWorktree}:worktree list --porcelain`,
      ...orders.map((order) => `${sourceWorktree}:worktree remove --force ${order.projectPath}`),
    ]);
  });

  it("removes only unreferenced orphan worktrees after the failure retention window", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-supervisor-resource-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const now = 100 * 60 * 60 * 1_000;
    const worktreeRoot = join(stateDir, "loop-worktrees", "app");
    const expiredOrphan = join(worktreeRoot, "expired-orphan");
    const youngOrphan = join(worktreeRoot, "young-orphan");
    const leasedOrphan = join(worktreeRoot, "leased-orphan");
    const referencedPath = join(worktreeRoot, "referenced-run");
    for (const path of [expiredOrphan, youngOrphan, leasedOrphan, referencedPath]) {
      mkdirSync(path, { recursive: true });
    }
    const olderThanRetention = new Date(now - 73 * 60 * 60 * 1_000);
    for (const path of [expiredOrphan, leasedOrphan, referencedPath]) {
      utimesSync(path, olderThanRetention, olderThanRetention);
    }
    const young = new Date(now - 1_000);
    utimesSync(youngOrphan, young, young);

    const referenced = workOrder(stateDir, {
      id: "referenced-run",
      projectPath: referencedPath,
      executionIsolation: {
        mode: "supervised-worker",
        expectedWorktree: referencedPath,
        sourceWorktree: join(stateDir, "source-app"),
        worktreeIsolation: "isolated",
        preparedBy: "system-git-worktree",
        contextReset: "compact",
        cleanup: {
          success: "release-worker",
          failure: "retain-for-ttl",
          retainFailureForHours: 72,
        },
      },
    });
    writeLoopSupervisorWorkOrderState({
      workOrder: referenced,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "dispatching",
      now,
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-worker-leased-orphan",
          workOrderId: "missing-run",
          projectId: "app",
          projectPath: leasedOrphan,
          status: "active",
          leasedAt: now - 1_000,
          updatedAt: now - 1_000,
        },
      ],
    });
    const calls: string[] = [];

    await expect(
      reconcileTerminalSupervisorResources({
        now,
        excludedWorkOrderIds: new Set([referenced.id]),
        runGit: (invocation) => {
          calls.push(`${invocation.cwd}:${invocation.args.join(" ")}`);
          if (invocation.args.join(" ") === "rev-parse --show-toplevel") {
            return { status: 0, stdout: `${invocation.cwd}\n`, stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toMatchObject({ removedOrphanWorktrees: 1 });

    expect(calls).toEqual([
      `${expiredOrphan}:rev-parse --show-toplevel`,
      `${expiredOrphan}:worktree remove --force ${expiredOrphan}`,
    ]);
  });

  it("terminalizes abandoned dispatches as dispatch timeouts, not invalid output", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-supervisor-resource-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const scheduledAt = 1_000;
    const order = workOrder(stateDir, { id: "abandoned-run" });
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "dispatching",
      now: scheduledAt,
    });

    await expect(
      reconcileTerminalSupervisorResources({
        now: scheduledAt + 13 * 60 * 60 * 1_000,
      }),
    ).resolves.toMatchObject({ abandonedWorkOrders: 1 });

    const state = JSON.parse(
      readFileSync(join(stateDir, "loop-runs", "app", "abandoned-run", "work-order-state.json"), {
        encoding: "utf8",
      }),
    ) as { status?: string; resultStatus?: string };
    expect(state).toMatchObject({
      status: "failed",
      resultStatus: "dispatch-timeout",
    });
  });
});
