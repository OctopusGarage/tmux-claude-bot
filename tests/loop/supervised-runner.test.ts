import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runLoopSupervisedProjectAsync,
  runLoopSupervisorRevisionAsync,
} from "../../src/core/loop/supervised-runner.js";
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
  assessment: { command: "pnpm assess" },
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

  it("retries supervisor dispatch when the model provider is temporarily at capacity", async () => {
    let attempts = 0;
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: 1,
            stdout: "",
            stderr: "Selected model is at capacity. Please try a different model.",
          };
        }
        return {
          status: 0,
          stdout:
            '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"completed","projectId":"datavibe","actionsTaken":["retried after provider capacity"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
          stderr: "",
        };
      },
    });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      status: "completed",
      summary: {
        actionsTaken: ["retried after provider capacity"],
        finalVerification: "passed",
      },
    });
  });

  it("retries status-zero Codex transport failures before parsing supervisor output", async () => {
    let attempts = 0;
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: 0,
            stdout:
              "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses",
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout:
            '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"completed","projectId":"datavibe","actionsTaken":["retried after Codex transport failure"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
          stderr: "",
        };
      },
    });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      status: "completed",
      summary: {
        actionsTaken: ["retried after Codex transport failure"],
        finalVerification: "passed",
      },
    });
  });

  it("classifies exhausted status-zero Codex transport failures as dispatch failures", async () => {
    const output =
      "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses";
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({ status: 0, stdout: output, stderr: "" }),
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: output,
      output,
    });
  });

  it("classifies Codex startup auth and MCP failures as dispatch failures", async () => {
    const output = [
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "MCP startup incomplete (failed: english-pilot)",
      "› Ask Codex to do anything",
    ].join("\n");
    let dispatches = 0;
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => {
        dispatches += 1;
        return { status: 0, stdout: output, stderr: "" };
      },
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "agent startup reported authentication, MCP, or hook initialization failure",
      output,
      repairDisposition: "bot-repairable",
    });
    expect(dispatches).toBe(1);
  });

  it("classifies Codex response-endpoint credential rejection as a startup auth failure", async () => {
    const output = [
      "unexpected status 401 Unauthorized: Incorrect API key provided: <redacted>",
      "url: https://chatgpt.com/backend-api/codex/responses",
      "› Ask Codex to do anything",
    ].join("\n");
    let dispatches = 0;
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => {
        dispatches += 1;
        return { status: 0, stdout: output, stderr: "" };
      },
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "agent startup reported authentication, MCP, or hook initialization failure",
      output,
      repairDisposition: "bot-repairable",
    });
    expect(dispatches).toBe(1);
  });

  it("classifies Codex startup hook failures as dispatch failures", async () => {
    const output = ["Hook failed", "hook exited with code 1", "Ask Codex to do anything"].join(
      "\n",
    );
    let dispatches = 0;
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => {
        dispatches += 1;
        return { status: 0, stdout: output, stderr: "" };
      },
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "agent startup reported authentication, MCP, or hook initialization failure",
      output,
      repairDisposition: "bot-repairable",
    });
    expect(dispatches).toBe(1);
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

  it("retries thrown supervisor model-capacity failures before failing the run", async () => {
    let attempts = 0;
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: () => {
        attempts += 1;
        throw new Error("Selected model is at capacity. Please try a different model.");
      },
    });

    expect(attempts).toBe(2);
    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "Selected model is at capacity. Please try a different model.",
      output: "Selected model is at capacity. Please try a different model.",
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
      repairDisposition: "bot-repairable",
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("did not include a parseable final summary");
  });

  it.each([
    "Not running — use /resume to restore it, or /start for a new session",
    "未运行，请使用 /resume 恢复，或 /start 新建",
    "未執行，請使用 /resume 復原，或 /start 新建",
    "実行されていません · /resume で復元、または /start で新規開始してください",
    "No está en ejecución — usa /resume para restaurarlo, o /start para iniciar uno nuevo",
  ])("classifies agent not-running output as dispatch readiness failure: %s", async (output) => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({
        status: 0,
        stdout: output,
        stderr: "",
      }),
    });

    expect(result).toEqual({
      status: "dispatch-failed",
      reason: "no live loop supervisor session",
      output,
      repairDisposition: "bot-repairable",
    });
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
      repairDisposition: "bot-repairable",
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("could not run its final gates");
  });

  it("classifies structurally valid summaries that fail WorkOrder validation as repairable invalid-output", async () => {
    const planningWorkOrder: LoopWorkOrder = {
      ...workOrder,
      planning: {
        required: true,
        source: "active-delegation",
        requireOwnerConfirmation: false,
        rubric: [],
        acceptanceCriteria: [],
        stopConditions: [],
        nonGoals: [],
      },
    };
    const output =
      '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"completed","projectId":"datavibe","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}';

    const result = await runLoopSupervisedProjectAsync({
      workOrder: planningWorkOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({ status: 0, stdout: output, stderr: "" }),
    });

    expect(result).toEqual({
      status: "invalid-output",
      reason: "invalid-summary",
      output: `${output}\n${output}`,
      repairDisposition: "bot-repairable",
    });
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

describe("runLoopSupervisorRevisionAsync", () => {
  it("uses the shared finalization fallback when revision output is missing the final marker", async () => {
    const prompts: string[] = [];
    const result = await runLoopSupervisorRevisionAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      failures: ["system gate rejected the final summary"],
      attempt: 1,
      maxAttempts: 2,
      previousOutput: "previous supervisor output",
      dispatch: async (request) => {
        prompts.push(request.prompt);
        expect(request.session).toBe("tmux_proj_loop-supervisor");
        expect(request.timeoutMs).toBe(1000);
        if (prompts.length === 1) {
          expect(request.prompt).toContain("system gate rejected the final summary");
          return { status: 0, stdout: "revision repaired state but omitted marker", stderr: "" };
        }
        expect(request.prompt).toContain("revision repaired state but omitted marker");
        return {
          status: 0,
          stdout:
            '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"completed","projectId":"datavibe","actionsTaken":["finalized revision"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
          stderr: "",
        };
      },
    });

    expect(prompts).toHaveLength(2);
    expect(result).toMatchObject({
      status: "completed",
      summary: {
        actionsTaken: ["finalized revision"],
        finalVerification: "passed",
      },
    });
  });
});

describe.each([
  { kind: "architecture", implementation: { kind: "ralphworks" } },
  {
    kind: "bug-fix",
    maxRounds: 1,
    maxBugsPerRound: 1,
    requireRegressionTest: true,
    implementation: { kind: "ralphworks" },
  },
  {
    kind: "test-coverage",
    targetCoverage: 90,
    maxRounds: 1,
    requireMeaningfulTests: true,
    allowIntegrationTests: false,
    allowSmokeTests: false,
    allowE2ETests: false,
    allowAiEvalTests: false,
    implementation: { kind: "ralphworks" },
  },
  {
    kind: "security-maintenance",
    maxRounds: 3,
    actionThreshold: 70,
    criticalThreshold: 90,
    allowDependencyUpdates: false,
    allowConfigHardening: true,
    allowStaticAnalysisFixes: false,
    implementation: { kind: "ralphworks" },
  },
] satisfies NonNullable<LoopWorkOrder["task"]>[])("external $kind execution", (task) => {
  const external: LoopWorkOrder = { ...workOrder, task };
  it("keeps an exhausted shared deadline terminal before native review", async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const dispatch = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
    try {
      const result = await runLoopSupervisedProjectAsync({
        workOrder: external,
        supervisorSession: "supervisor",
        timeoutMs: 1000,
        deadline: now + 1000,
        executeTask: async () => {
          now += 1001;
          return {
            invocationId: "nonce",
            taskInputSha256: "hash",
            receiptFile: "/evidence/receipt.json",
            receiptSha256: "hash",
            archivePath: "/evidence/ralph-state",
            profileFingerprint: "hash",
          };
        },
        dispatch,
      });
      expect(result).toMatchObject({
        status: "dispatch-timeout",
        finalSummaryRecovery: "disabled",
      });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("reports an expired review deadline as timeout before retrying transport failure", async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let dispatches = 0;
    try {
      const result = await runLoopSupervisedProjectAsync({
        workOrder: external,
        supervisorSession: "supervisor",
        timeoutMs: 1000,
        executeTask: async () => ({
          invocationId: "nonce",
          taskInputSha256: "hash",
          receiptFile: "/evidence/receipt.json",
          receiptSha256: "hash",
          archivePath: "/evidence/ralph-state",
          profileFingerprint: "hash",
        }),
        dispatch: async () => {
          dispatches++;
          now += 1001;
          return { status: 1, stdout: "", stderr: "API Error: 503 overloaded" };
        },
      });
      expect(dispatches).toBe(1);
      expect(result.status).toBe("dispatch-timeout");
    } finally {
      clock.mockRestore();
    }
  });

  it("gives review its remaining fixed deadline and reduces it across transport retries", async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    try {
      const result = await runLoopSupervisedProjectAsync({
        workOrder: external,
        supervisorSession: "supervisor",
        timeoutMs: 1000,
        executeTask: async () => {
          now += 250;
          return {
            invocationId: "nonce",
            taskInputSha256: "hash",
            receiptFile: "/evidence/receipt.json",
            receiptSha256: "hash",
            archivePath: "/evidence/ralph-state",
            profileFingerprint: "hash",
          };
        },
        dispatch: async (request) => {
          if (request.timeoutMs === undefined) throw new Error("Expected bounded dispatch");
          timeouts.push(request.timeoutMs);
          expect(request.prompt).toContain(new Date(1_800_000_001_000).toISOString());
          expect(request.prompt).toContain("Required-check timeouts are not assertion failures");
          expect(request.prompt).toContain("retain the original timeout evidence");
          expect(request.prompt).toContain("Do not retry failed assertions");
          if (timeouts.length === 1) {
            now += 100;
            return { status: 1, stdout: "", stderr: "API Error: 503 overloaded" };
          }
          return {
            status: 0,
            stdout:
              '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"blocked","projectId":"datavibe","actionsTaken":["required assertion failed"],"delegatedTasks":[],"finalVerification":"failed","commits":[],"followUps":[]}',
            stderr: "",
          };
        },
      });
      expect(timeouts).toEqual([750, 650]);
      expect(result.status).toBe("blocked");
    } finally {
      clock.mockRestore();
    }
  });
  it("executes RalphWorks before native review and never uses native implementation instructions", async () => {
    const events: string[] = [];
    const result = await runLoopSupervisedProjectAsync({
      workOrder: external,
      supervisorSession: "supervisor",
      timeoutMs: 1000,
      executeTask: async ({ timeoutMs }) => {
        expect(timeoutMs).toBe(800);
        events.push("ralph");
        return {
          invocationId: "nonce",
          taskInputSha256: "hash",
          receiptFile: "/evidence/receipt.json",
          receiptSha256: "hash",
          archivePath: "/evidence/ralph-state",
          profileFingerprint: "hash",
        };
      },
      dispatch: async ({ prompt }) => {
        events.push("review");
        expect(prompt).toContain("review and delivery only");
        expect(prompt).toContain("Do not rerun RalphWorks");
        expect(prompt).not.toContain("Before assessment or delegated work, sync");
        expect(prompt).not.toContain("create or reset the WorkOrder branch");
        return {
          status: 0,
          stdout:
            '[LOOP_SUPERVISOR_DONE:wo-1]\n{"status":"blocked","projectId":"datavibe","actionsTaken":["missing pre-mutation evidence"],"delegatedTasks":[],"finalVerification":"not-run","commits":[],"followUps":[]}',
          stderr: "",
        };
      },
    });
    expect(events).toEqual(["ralph", "review"]);
    expect(result.status).toBe("blocked");
  });

  it("disables summary recovery and native fallback after external failure", async () => {
    let dispatches = 0;
    const result = await runLoopSupervisedProjectAsync({
      workOrder: external,
      supervisorSession: "supervisor",
      timeoutMs: 1000,
      executeTask: async () => {
        throw new Error("receipt rejected");
      },
      dispatch: async () => {
        dispatches++;
        throw new Error("must not dispatch");
      },
    });
    expect(result).toMatchObject({ status: "dispatch-failed", finalSummaryRecovery: "disabled" });
    expect(dispatches).toBe(0);
  });

  it("awaits external cancellation cleanup before returning", async () => {
    const controller = new AbortController();
    let stopped = false;
    const result = runLoopSupervisedProjectAsync({
      workOrder: external,
      supervisorSession: "supervisor",
      timeoutMs: 1000,
      cancelSignal: controller.signal,
      executeTask: async ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              stopped = true;
              reject(new Error("cancelled after stop"));
            }, 20),
          );
        }),
      dispatch: async () => {
        throw new Error("must not dispatch");
      },
    });
    controller.abort();
    await result;
    expect(stopped).toBe(true);
  });
});
