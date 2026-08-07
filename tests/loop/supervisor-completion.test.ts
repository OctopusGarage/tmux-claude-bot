import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyLoopSupervisorScheduleRetry,
  completeLoopSupervisorRun,
} from "../../src/core/loop/supervisor-completion.js";
import { workOrderStateForResult } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

const workOrder = {
  id: "wo-completion",
  scheduledAt: 1_000,
  projectId: "hub",
  projectName: "Hub",
  projectPath: "/repo/hub",
  agent: "codex",
  goal: "Improve architecture.",
  maxRounds: 3,
  targetScore: 90,
  runner: { kind: "agent-supervised", timeoutMs: 1000, requireConfirmation: false },
  allowedActions: ["tests"],
  blockedActions: ["direct-model-api"],
  skills: { approved: [] },
  preflight: { commands: [], repair: { agent: false } },
  assessment: { command: "npm run assess" },
  execution: { agent: true },
  recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
  commitPolicy: { enabled: false, perRound: true },
  requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:wo-completion]",
} satisfies LoopWorkOrder;

describe("completeLoopSupervisorRun", () => {
  it("persists invalid supervisor output as a terminal failed state", () => {
    expect(
      workOrderStateForResult({
        status: "invalid-output",
        reason: "missing-final-marker",
        output: "",
      }),
    ).toBe("failed");
  });

  it("classifies retryable supervisor dispatch delivery failures by retry kind", () => {
    const retry = classifyLoopSupervisorScheduleRetry({
      status: "dispatch-failed",
      reason: "loop supervisor task queue is full",
      output: "loop supervisor task queue is full",
    });

    expect(retry).toEqual({
      retrySchedule: true,
      kind: "supervisor-dispatch-unavailable",
    });
  });

  it("classifies a worker that never consumes a queued prompt as retryable delivery", () => {
    expect(
      classifyLoopSupervisorScheduleRetry({
        status: "dispatch-failed",
        reason: "loop supervisor worker did not consume queued task before deadline",
        output: "loop supervisor worker did not consume queued task before deadline",
      }),
    ).toEqual({
      retrySchedule: true,
      kind: "supervisor-dispatch-unavailable",
    });
  });

  it("classifies model-capacity dispatch failures as retryable agent transient failures", () => {
    const retry = classifyLoopSupervisorScheduleRetry({
      status: "dispatch-failed",
      reason: "Selected model is at capacity. Please try a different model.",
      output: "Selected model is at capacity. Please try a different model.",
    });

    expect(retry).toEqual({
      retrySchedule: true,
      kind: "agent-transient-failure",
    });
  });

  it("classifies invalid final output as an output-contract retry", () => {
    const retry = classifyLoopSupervisorScheduleRetry({
      status: "invalid-output",
      reason: "invalid-summary",
      output: "[LOOP_SUPERVISOR_DONE:wo-completion]\n{}",
    });

    expect(retry).toEqual({
      retrySchedule: true,
      kind: "supervisor-output-contract",
    });
  });

  it("does not retry non-delivery dispatch failures", () => {
    const retry = classifyLoopSupervisorScheduleRetry({
      status: "dispatch-failed",
      reason: "agent command exited 2",
      output: "agent command exited 2",
    });

    expect(retry).toEqual({
      retrySchedule: false,
      kind: "not-retryable",
    });
  });

  it("returns retrySchedule for dispatch failures caused by unavailable supervisor delivery", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-completion-"));

    const completion = completeLoopSupervisorRun({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 1_000,
      endedAt: 2_000,
      result: {
        status: "dispatch-failed",
        reason: "loop supervisor task queue is full",
        output: "loop supervisor task queue is full",
      },
    });

    expect(completion.retrySchedule).toBe(true);
    expect(completion.report).toEqual(
      expect.objectContaining({
        runId: "wo-completion",
      }),
    );
  });

  it("does not retry schedule for supervisor task failures after dispatch succeeded", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-completion-"));

    const completion = completeLoopSupervisorRun({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 1_000,
      endedAt: 2_000,
      result: {
        status: "supervisor-failed",
        output: "task failed",
        summary: {
          status: "failed",
          projectId: "hub",
          actionsTaken: [],
          delegatedTasks: [],
          finalVerification: "failed",
          commits: [],
          followUps: [],
        },
      },
    });

    expect(completion.retrySchedule).toBe(false);
  });

  it("returns retrySchedule when supervisor output is missing the final marker", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-completion-"));

    const completion = completeLoopSupervisorRun({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 1_000,
      endedAt: 2_000,
      result: {
        status: "invalid-output",
        reason: "missing-final-marker",
        output: "target agent is still finishing the delegated slice",
      },
    });

    expect(completion.retrySchedule).toBe(true);
  });

  it("returns retrySchedule for invalid supervisor summary JSON", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-completion-"));

    const completion = completeLoopSupervisorRun({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 1_000,
      endedAt: 2_000,
      result: {
        status: "invalid-output",
        reason: "invalid-summary",
        output: "[LOOP_SUPERVISOR_DONE:wo-completion]\n{}",
      },
    });

    expect(completion.retrySchedule).toBe(true);
  });
});
