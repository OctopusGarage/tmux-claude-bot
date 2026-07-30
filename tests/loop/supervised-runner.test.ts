import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoopSupervisedProjectAsync } from "../../src/core/loop/supervised-runner.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const defaultFinalSummaryPath = join(
  mkdtempSync(join(tmpdir(), "tcb-loop-supervised-runner-default-")),
  "supervisor-final-summary.json",
);

const workOrder: LoopWorkOrder = {
  id: "wo-1",
  scheduledAt: 1,
  projectId: "datavibe",
  projectName: "Datavibe",
  projectPath: "/repo/datavibe",
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
  requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:wo-1]",
  finalSummaryPath: defaultFinalSummaryPath,
};

function workOrderWithFinalSummaryPath(finalSummaryPath: string): LoopWorkOrder {
  return { ...workOrder, finalSummaryPath };
}

describe("runLoopSupervisedProjectAsync", () => {
  it("dispatches the work order prompt to the supervisor and parses completed output", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async (request) => {
        expect(request.session).toBe("tmux_proj_loop-supervisor");
        expect(request.prompt).toContain('"id": "wo-1"');
        expect(request.prompt).toContain('"runner"');
        expect(request.prompt).toContain("[LOOP_SUPERVISOR_DONE:wo-1]");
        expect(request.signal.aborted).toBe(false);
        return {
          status: 0,
          stdout:
            '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"completed","projectId":"datavibe","actionsTaken":["ran tests"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}',
          stderr: "",
        };
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      summary: {
        finalVerification: "passed",
        actionsTaken: ["ran tests"],
        commits: ["abc123"],
      },
      output:
        '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"completed","projectId":"datavibe","actionsTaken":["ran tests"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}',
    });
  });

  it("returns failed when dispatch exits non-zero", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({ status: 1, stdout: "partial output", stderr: "queue full" }),
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "queue full",
      output: "partial output\nqueue full",
    });
  });

  it("returns timeout and aborts dispatch when dispatch does not finish before the deadline", async () => {
    let signal: AbortSignal | undefined;
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1,
      dispatch: (request) => {
        signal = request.signal;
        return new Promise(() => {});
      },
    });

    expect(result).toEqual({
      status: "dispatch-timeout",
      reason: "loop supervisor work order timed out",
      output: "loop supervisor work order timed out",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("returns cancelled and aborts dispatch when the external signal is cancelled", async () => {
    let signal: AbortSignal | undefined;
    const controller = new AbortController();
    const running = runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      cancelSignal: controller.signal,
      dispatch: (request) => {
        signal = request.signal;
        return new Promise(() => {});
      },
    });

    controller.abort("cancelled by user");
    const result = await running;

    expect(result).toMatchObject({
      status: "cancelled",
      summary: {
        status: "cancelled",
        projectId: "datavibe",
        finalVerification: "not-run",
      },
      output: "cancelled by user",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("returns failed when dispatch throws synchronously", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: () => {
        throw new Error("send failed");
      },
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "send failed",
      output: "send failed",
    });
  });

  it("returns failed when successful dispatch output has no final marker", async () => {
    const prompts: string[] = [];
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async (request) => {
        prompts.push(request.prompt);
        return { status: 0, stdout: "done without marker", stderr: "" };
      },
    });

    expect(result).toEqual({
      status: "invalid-output",
      reason: "missing-final-marker",
      output: "done without marker\ndone without marker",
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("did not include a parseable final summary");
  });

  it("asks the supervisor to finalize once when the first output misses the final marker", async () => {
    const prompts: string[] = [];
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return { status: 0, stdout: "target agent verified but no marker", stderr: "" };
        }
        return {
          status: 0,
          stdout:
            '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"completed","projectId":"datavibe","actionsTaken":["finalized"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}',
          stderr: "",
        };
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("target agent verified but no marker");
    expect(result).toMatchObject({
      status: "completed",
      summary: {
        actionsTaken: ["finalized"],
        finalVerification: "passed",
        commits: ["abc123"],
      },
    });
  });

  it("accepts the final summary file when terminal output after the marker is truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-supervised-runner-"));
    const finalSummaryPath = join(dir, "supervisor-final-summary.json");
    writeFileSync(
      finalSummaryPath,
      JSON.stringify({
        status: "blocked",
        projectId: "datavibe",
        actionsTaken: ["pushed branch but PR permission failed"],
        delegatedTasks: ["Round 1: refactored a helper"],
        finalVerification: "passed",
        commits: ["abc123"],
        followUps: ["Grant PR permission"],
      }),
    );

    const result = await runLoopSupervisedProjectAsync({
      workOrder: workOrderWithFinalSummaryPath(finalSummaryPath),
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({
        status: 0,
        stdout: '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"blocked"',
        stderr: "",
      }),
    });

    expect(result).toMatchObject({
      status: "blocked",
      summary: {
        actionsTaken: ["pushed branch but PR permission failed"],
        delegatedTasks: ["Round 1: refactored a helper"],
        finalVerification: "passed",
        commits: ["abc123"],
      },
    });
  });

  it("asks the supervisor to finalize once when the final summary JSON is invalid", async () => {
    const prompts: string[] = [];
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async (request) => {
        prompts.push(request.prompt);
        return {
          status: 0,
          stdout: "[LOOP_SUPERVISOR_DONE:wo-1]\n{}",
          stderr: "",
        };
      },
    });

    expect(result).toEqual({
      status: "invalid-output",
      reason: "invalid-summary",
      output: "[LOOP_SUPERVISOR_DONE:wo-1]\n{}\n[LOOP_SUPERVISOR_DONE:wo-1]\n{}",
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("could not run its final gates");
  });

  it("accepts a successful status alias from the finalization response", async () => {
    const prompts: string[] = [];
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async (request) => {
        prompts.push(request.prompt);
        return {
          status: 0,
          stdout:
            prompts.length === 1
              ? '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"done"}'
              : '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"complete","projectId":"datavibe","actionsTaken":["score=95, no changes needed"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
          stderr: "",
        };
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      summary: {
        status: "completed",
        actionsTaken: ["score=95, no changes needed"],
        finalVerification: "passed",
      },
    });
    expect(prompts).toHaveLength(2);
  });

  it("returns blocked when the supervisor final summary is blocked", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({
        status: 0,
        stdout:
          '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"blocked","projectId":"datavibe","actionsTaken":["checked state"],"delegatedTasks":[],"finalVerification":"not-run","commits":[],"followUps":["needs approval"]}',
        stderr: "",
      }),
    });

    expect(result).toMatchObject({
      status: "blocked",
      summary: {
        finalVerification: "not-run",
        followUps: ["needs approval"],
      },
    });
  });

  it("distinguishes a supervisor failed summary from dispatch failure", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({
        status: 0,
        stdout:
          '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"failed","projectId":"datavibe","actionsTaken":["ran"],"delegatedTasks":[],"finalVerification":"failed","commits":[],"followUps":[]}',
        stderr: "",
      }),
    });

    expect(result).toMatchObject({
      status: "supervisor-failed",
      summary: {
        finalVerification: "failed",
      },
    });
  });

  it("does not treat dispatch exit 124 as the internal timeout sentinel", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({ status: 124, stdout: "", stderr: "command timed out" }),
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "command timed out",
      output: "command timed out",
    });
  });
});
