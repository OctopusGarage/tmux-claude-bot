import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readLoopSupervisorWorkerLeaseState,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
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

function writeSummary(
  path: string,
  status: "completed" | "failed" | "blocked" = "completed",
): void {
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

  it("does not report accepted blocked system gates as mismatched", async () => {
    const runId = arrangeTerminalRun("failed", true);
    const runDir = join(process.env.TCB_STATE_DIR ?? "", "loop-runs", "tmux-claude-bot", runId);
    writeSummary(join(runDir, "supervisor-final-summary.json"), "blocked");
    writeFileSync(
      join(runDir, "system-gate.json"),
      `${JSON.stringify({
        accepted: true,
        resultStatus: "blocked",
        workOrderId: runId,
        projectId: "tmux-claude-bot",
      })}\n`,
    );
    startLedger(runId);

    const result = await reconcileAutopilotDelegatedTasks({ now: 3 });

    expect(result).toMatchObject({ finished: 0, failed: 1 });
    expect(
      new DailyTaskLedger().listAll().find((item) => item.taskId === `autopilot:${runId}`),
    ).toMatchObject({
      status: "failed",
      repairStatus: "pending",
      error: "Autopilot delegated task reconciliation failed: terminal summary status=blocked",
    });
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

  it("settles non-terminal state and active lease when restart finds accepted final artifacts", async () => {
    const runId = arrangeTerminalRun("in-flight", true);
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor-reconciliation",
          workOrderId: runId,
          projectId: "tmux-claude-bot",
          projectPath: "/repo/tmux-claude-bot",
          status: "active",
          leasedAt: 1,
          updatedAt: 2,
        },
      ],
    });
    startLedger(runId);

    const result = await reconcileAutopilotDelegatedTasks({ now: 3 });

    const statePath = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "tmux-claude-bot",
      runId,
      "work-order-state.json",
    );
    expect(result.finished).toBe(1);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      status: "completed",
      resultStatus: "completed",
    });
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([]);
  });

  it("keeps a running ledger entry reserved while its final summary awaits the system gate", async () => {
    const runId = arrangeTerminalRun("in-flight", false);
    startLedger(runId);

    const result = await reconcileAutopilotDelegatedTasks({ now: 3 });

    expect(result).toMatchObject({ checked: 0, finished: 0, failed: 0 });
    expect(
      new DailyTaskLedger().listAll().find((item) => item.taskId === `autopilot:${runId}`),
    ).toMatchObject({ status: "running" });
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

  it("settles open system self-heal deferrals from an operator-equivalent active delegation", async () => {
    const runId = arrangeTerminalRun("completed", true);
    const runDir = join(process.env.TCB_STATE_DIR ?? "", "loop-runs", "tmux-claude-bot", runId);
    const workOrderPath = join(runDir, "work-order.json");
    const order = JSON.parse(readFileSync(workOrderPath, "utf8"));
    order.task = {
      kind: "active-delegated-task",
      requirement:
        "Run an operator-equivalent investigation of tmux-claude-bot automation tasks from the last 24 hours.",
    };
    writeFileSync(workOrderPath, `${JSON.stringify(order)}\n`);

    const coordinator = new RepairCoordinator();
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "system-self-heal",
      taskFamily: "tmux-claude-bot system self-heal agent sweep",
      fingerprint: "system-gate",
      taskId: "system-self-heal:agent-sweep:1000",
      now: 1,
    });

    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "system-self-heal:agent-sweep:1000",
      source: "system-self-heal",
      name: "tmux-claude-bot system self-heal agent sweep",
      scheduledAt: 1,
    });
    ledger.fail("system-self-heal:agent-sweep:1000", {
      endedAt: 1,
      error: "automation admission deferred: background-closed",
    });
    startLedger(runId);

    await reconcileAutopilotDelegatedTasks({ now: 3, ledger });

    expect(
      ledger.listAll().find((record) => record.taskId === "system-self-heal:agent-sweep:1000"),
    ).toMatchObject({
      repairStatus: "fixed",
      summary: "Closed from the authoritative successful operator-equivalent self-heal delegation.",
    });
    expect(coordinator.list()[0]).toMatchObject({
      status: "fixed",
      linkedTaskIds: ["system-self-heal:agent-sweep:1000", `autopilot:${runId}`],
    });
  });
});
