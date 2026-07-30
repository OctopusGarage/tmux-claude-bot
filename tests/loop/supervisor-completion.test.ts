import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeLoopSupervisorRun } from "../../src/core/loop/supervisor-completion.js";
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
