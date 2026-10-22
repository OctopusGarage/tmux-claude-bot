import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverInvalidOutputFromFinalSummary,
  recoverInvalidOutputFromFinalSummaryAsync,
} from "../../src/core/loop/final-summary-recovery.js";
import {
  runLoopSupervisedProjectAsync,
  runLoopSupervisorRevisionAsync,
} from "../../src/core/loop/supervised-runner.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

afterEach(() => vi.restoreAllMocks());

function fixture(): LoopWorkOrder {
  return {
    id: "budget-run",
    projectId: "app",
    projectName: "App",
    projectPath: "/repo/app",
    scheduledAt: 1,
    agent: "codex",
    goal: "Complete the confirmed task.",
    maxRounds: 3,
    targetScore: 90,
    runner: { kind: "agent-supervised", timeoutMs: 1000, requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "pnpm assess" },
    execution: { agent: true },
    recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: true },
    task: {
      kind: "active-delegated-task",
      sourceSession: "project-app",
      requirement: "Finish.",
      requireReview: true,
      requireTests: true,
      requireCoverageReview: true,
      allowAiEval: false,
    },
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:budget-run]",
    finalSummaryPath: join(mkdtempSync(join(tmpdir(), "tcb-budget-")), "final.json"),
  };
}

function output() {
  return {
    status: 0,
    stderr: "",
    stdout:
      '[LOOP_SUPERVISOR_DONE:budget-run]\n{"status":"completed","projectId":"app","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
  };
}

describe("durable delegation dispatch budget", () => {
  it("does not renew the deadline when execution is resumed", async () => {
    const workOrder = fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const dispatch = vi.fn(async () => output());
    const input = { workOrder, supervisorSession: "supervisor", timeoutMs: 1000, dispatch };
    await runLoopSupervisedProjectAsync(input);
    now.mockReturnValue(1900);
    await runLoopSupervisedProjectAsync(input);
    expect(dispatch.mock.calls).toHaveLength(2);
    now.mockReturnValue(2001);
    expect((await runLoopSupervisedProjectAsync(input)).status).toBe("dispatch-timeout");
    expect(dispatch.mock.calls).toHaveLength(2);
  });

  it("persists revision consumption even when callers restart their local counter", async () => {
    const workOrder = fixture();
    const dispatch = vi.fn(async () => output());
    const input = {
      workOrder,
      supervisorSession: "supervisor",
      timeoutMs: 1000,
      dispatch,
      failures: ["checkpoint acceptance incomplete"],
      attempt: 1,
      maxAttempts: 2,
      previousOutput: "",
    };
    await runLoopSupervisorRevisionAsync(input);
    await runLoopSupervisorRevisionAsync(input);
    const denied = await runLoopSupervisorRevisionAsync({ ...input, maxAttempts: 10 });
    expect(denied.status).toBe("dispatch-failed");
    writeFileSync(workOrder.finalSummaryPath ?? "missing", output().stdout.split("\n")[1] ?? "");
    expect(recoverInvalidOutputFromFinalSummary(workOrder, denied)).toBe(denied);
    expect(await recoverInvalidOutputFromFinalSummaryAsync(workOrder, denied)).toBe(denied);
    expect(denied.output).toContain("revision budget exhausted");
    expect(dispatch).toHaveBeenCalledTimes(2);
    const state = JSON.parse(
      readFileSync(
        join(workOrder.finalSummaryPath ?? "missing", "..", "delegation-budget.json"),
        "utf8",
      ),
    );
    expect(state.revisionsUsed).toBe(2);
  });

  it("fails closed on corrupt persisted budget", async () => {
    const workOrder = fixture();
    const dispatch = vi.fn(async () => output());
    const input = { workOrder, supervisorSession: "supervisor", timeoutMs: 1000, dispatch };
    await runLoopSupervisedProjectAsync(input);
    writeFileSync(
      join(workOrder.finalSummaryPath ?? "missing", "..", "delegation-budget.json"),
      "{",
    );
    expect((await runLoopSupervisedProjectAsync(input)).status).toBe("dispatch-failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not finalize a late response after the deadline", async () => {
    const workOrder = fixture();
    let resolve!: (value: ReturnType<typeof output>) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<ReturnType<typeof output>>((done) => {
          resolve = done;
        }),
    );
    const running = runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "supervisor",
      timeoutMs: 10,
      dispatch,
    });
    // Keep the test alive while the runner's unreferenced deadline timer fires.
    await new Promise((done) => setTimeout(done, 20));
    expect((await running).status).toBe("dispatch-timeout");
    resolve({ status: 0, stdout: "no final summary", stderr: "" });
    await new Promise((done) => setTimeout(done, 10));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects another WorkOrder contract reusing a budget artifact", async () => {
    const workOrder = fixture();
    const dispatch = vi.fn(async () => output());
    const input = { workOrder, supervisorSession: "supervisor", timeoutMs: 1000, dispatch };
    await runLoopSupervisedProjectAsync(input);
    const result = await runLoopSupervisedProjectAsync({
      ...input,
      workOrder: { ...workOrder, goal: "A different task" },
    });
    expect(result.status).toBe("dispatch-failed");
    expect(result.output).toContain("contract mismatch");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not finalize a late response after cancellation", async () => {
    const workOrder = fixture();
    const controller = new AbortController();
    let resolve!: (value: ReturnType<typeof output>) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<ReturnType<typeof output>>((done) => {
          resolve = done;
        }),
    );
    const running = runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "supervisor",
      timeoutMs: 1000,
      dispatch,
      cancelSignal: controller.signal,
    });
    controller.abort("cancelled");
    expect((await running).status).toBe("cancelled");
    resolve({ status: 0, stdout: "no final summary", stderr: "" });
    await new Promise((done) => setTimeout(done, 10));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
