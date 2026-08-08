import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { RepairCoordinator } from "../../src/core/tasks/repair-coordinator.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";
import {
  type AutopilotDelegatedTaskReconciliation,
  reconcileAutopilotDelegatedTasks,
} from "../../src/core/tasks/task-reconciliation.js";

const originalStateDir = process.env.TCB_STATE_DIR;

function workOrder(id: string, runDir: string): LoopWorkOrder {
  return {
    id,
    projectId: "tmux-claude-bot",
    projectName: "tmux-claude-bot",
    projectPath: "/repo/tmux-claude-bot",
    scheduledAt: 1,
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${id}]`,
    finalSummaryPath: join(runDir, "supervisor-final-summary.json"),
    workerSession: "tmux_proj_loop-worker-reconciliation",
  } as unknown as LoopWorkOrder;
}

function writeSummary(path: string, status: "completed" | "failed" = "completed"): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      status,
      projectId: "tmux-claude-bot",
      actionsTaken: [],
      delegatedTasks: [],
      finalVerification: status === "completed" ? "passed" : "failed",
      commits: [],
      followUps: [],
    })}\n`,
  );
}

function arrangeTerminalRun(
  status: "completed" | "failed" | "in-flight",
  withGate: boolean,
): string {
  const runId = `1785919597241-tmux-claude-bot-active-delegate-${status}-${withGate}`;
  const runDir = join(process.env.TCB_STATE_DIR ?? "", "loop-runs", "tmux-claude-bot", runId);
  mkdirSync(runDir, { recursive: true });
  const order = workOrder(runId, runDir);
  writeLoopSupervisorWorkOrderState({
    workOrder: order,
    supervisorSession: "tmux_proj_loop-supervisor-reconciliation",
    status,
    now: 2,
    resultStatus: status === "failed" ? "invalid-output" : "completed",
  });
  writeSummary(
    order.finalSummaryPath ?? join(runDir, "supervisor-final-summary.json"),
    status === "failed" ? "failed" : "completed",
  );
  if (withGate) {
    writeFileSync(
      join(runDir, "system-gate.json"),
      `${JSON.stringify({
        workOrderId: runId,
        projectId: order.projectId,
        resultStatus: "completed",
        accepted: true,
      })}\n`,
    );
  }
  return runId;
}

function startLedger(runId: string): void {
  const ledger = new DailyTaskLedger();
  const taskId = `autopilot:${runId}`;
  ledger.expect({
    taskId,
    source: "autopilot-delegate",
    name: "tmux-claude-bot active delegated task",
    scheduledAt: 1,
  });
  ledger.start(taskId, 1);
}

describe("autopilot delegated task reconciliation", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-reconciliation-"));
  });

  afterEach(() => {
    const stateDir = process.env.TCB_STATE_DIR;
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = originalStateDir;
  });

  it("closes a running ledger entry after a terminal completed run", async () => {
    const runId = arrangeTerminalRun("completed", true);
    startLedger(runId);

    const cleaned: string[] = [];
    const result: AutopilotDelegatedTaskReconciliation = await reconcileAutopilotDelegatedTasks({
      now: 3,
      cleanupWorkerSession: async (session) => {
        cleaned.push(session);
      },
    });

    expect(result.finished).toBe(1);
    expect(result.failed).toBe(0);
    expect(cleaned).toEqual(["tmux_proj_loop-worker-reconciliation"]);
    expect(
      new DailyTaskLedger().listAll().find((item) => item.taskId === `autopilot:${runId}`),
    ).toMatchObject({ status: "success", repairStatus: "not-needed" });
  });

  it("fails, rather than leaving running, when the terminal run has no system gate", async () => {
    const runId = arrangeTerminalRun("failed", false);
    startLedger(runId);

    const result = await reconcileAutopilotDelegatedTasks({ now: 3 });

    expect(result.finished).toBe(0);
    expect(result.failed).toBe(1);
    expect(
      new DailyTaskLedger().listAll().find((item) => item.taskId === `autopilot:${runId}`),
    ).toMatchObject({ status: "failed", repairStatus: "pending" });
  });

  it("fails, rather than closing a repair, when the system gate rejected a completed summary", async () => {
    const runId = arrangeTerminalRun("completed", true);
    const runDir = join(process.env.TCB_STATE_DIR ?? "", "loop-runs", "tmux-claude-bot", runId);
    writeFileSync(
      join(runDir, "system-gate.json"),
      `${JSON.stringify({ accepted: false, resultStatus: "blocked", failures: ["gate rejected"] })}\n`,
    );
    startLedger(runId);

    const result = await reconcileAutopilotDelegatedTasks({ now: 3 });

    expect(result.finished).toBe(0);
    expect(result.failed).toBe(1);
    expect(
      new DailyTaskLedger().listAll().find((item) => item.taskId === `autopilot:${runId}`),
    ).toMatchObject({ status: "failed", repairStatus: "pending" });
  });

  it("fails, rather than closing a repair, when the system gate is malformed", async () => {
    const runId = arrangeTerminalRun("completed", true);
    const runDir = join(process.env.TCB_STATE_DIR ?? "", "loop-runs", "tmux-claude-bot", runId);
    writeFileSync(join(runDir, "system-gate.json"), "{}\n");
    startLedger(runId);

    const result = await reconcileAutopilotDelegatedTasks({ now: 3 });

    expect(result.finished).toBe(0);
    expect(result.failed).toBe(1);
    expect(
      new DailyTaskLedger().listAll().find((item) => item.taskId === `autopilot:${runId}`),
    ).toMatchObject({ status: "failed", repairStatus: "pending" });
  });

  it("closes a running ledger entry when restart finds a final summary before state is terminal", async () => {
    const runId = arrangeTerminalRun("in-flight", true);
    startLedger(runId);

    const result = await reconcileAutopilotDelegatedTasks({ now: 3 });

    expect(result.finished).toBe(1);
    expect(
      new DailyTaskLedger().listAll().find((item) => item.taskId === `autopilot:${runId}`),
    ).toMatchObject({ status: "success", repairStatus: "not-needed" });
  });

  it("is idempotent after the ledger and worker have been reconciled", async () => {
    const runId = arrangeTerminalRun("completed", true);
    startLedger(runId);
    await reconcileAutopilotDelegatedTasks({ now: 3 });

    const second = await reconcileAutopilotDelegatedTasks({ now: 4 });

    expect(second.finished).toBe(0);
    expect(second.failed).toBe(0);
    expect(existsSync(join(process.env.TCB_STATE_DIR ?? "", "scheduled_task_ledger.json"))).toBe(
      true,
    );
  });

  it("propagates a delegated repair success to its original failed task", async () => {
    const runId = arrangeTerminalRun("completed", true);
    const coordinator = new RepairCoordinator();
    const queueRecord = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "daily-audit",
      taskFamily: "audit-repair",
      fingerprint: "invalid-summary",
      taskId: "autopilot:original",
      now: 1,
    });
    coordinator.linkTaskIds(queueRecord.id, [`autopilot:${runId}`], 2);
    coordinator.claimIds([queueRecord.id], { now: 3, leaseId: "repair", limit: 1 });
    coordinator.markRunning(queueRecord.id, "repair", 4);

    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "autopilot:original",
      source: "autopilot-delegate",
      name: "tmux-claude-bot active delegated task",
      scheduledAt: 1,
    });
    ledger.fail("autopilot:original", { endedAt: 2, error: "invalid-summary" });
    ledger.markRepairStatus("autopilot:original", { repairStatus: "running", updatedAt: 4 });
    startLedger(runId);

    await reconcileAutopilotDelegatedTasks({ now: 6, ledger });

    expect(ledger.listAll().find((record) => record.taskId === "autopilot:original")).toMatchObject(
      {
        repairStatus: "fixed",
      },
    );
    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });
  });
});
