import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLoopSupervisorReport } from "../../src/core/loop/supervisor-report.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

const workOrder = {
  id: "wo-1",
  scheduledAt: 1_000,
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
} satisfies LoopWorkOrder;

describe("writeLoopSupervisorReport", () => {
  it("writes markdown and JSON supervisor reports for a completed summary", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-report-"));

    const report = writeLoopSupervisorReport({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 2_000,
      endedAt: 3_000,
      result: {
        status: "completed",
        output: "supervisor transcript",
        summary: {
          status: "completed",
          projectId: "datavibe",
          actionsTaken: ["ran focused tests", "committed scoped changes"],
          delegatedTasks: [{ projectId: "datavibe-docs", status: "completed" }],
          finalVerification: "passed",
          commits: ["abc123"],
          followUps: [],
        },
      },
    });

    expect(report).toMatchObject({
      runId: "wo-1",
      markdownPath: join(
        process.env.TCB_STATE_DIR,
        "loop-runs",
        "datavibe",
        "wo-1",
        "supervisor.md",
      ),
      summaryPath: join(
        process.env.TCB_STATE_DIR,
        "loop-runs",
        "datavibe",
        "wo-1",
        "supervisor-summary.json",
      ),
    });

    const markdown = await readFile(report.markdownPath, "utf8");
    expect(markdown).toContain("# Loop Supervisor Report");
    expect(markdown).toContain("- Work Order: wo-1");
    expect(markdown).toContain("- Project: Datavibe (`datavibe`)");
    expect(markdown).toContain("- Status: completed");
    expect(markdown).toContain("- Supervisor: tmux_proj_loop-supervisor");
    expect(markdown).toContain("- ran focused tests");
    expect(markdown).toContain("- committed scoped changes");
    expect(markdown).toContain("```text\nsupervisor transcript\n```");

    expect(JSON.parse(await readFile(report.summaryPath, "utf8"))).toMatchObject({
      workOrderId: "wo-1",
      runId: "wo-1",
      project: {
        id: "datavibe",
        name: "Datavibe",
        path: "/repo/datavibe",
        agent: "codex",
      },
      status: "completed",
      supervisor: {
        session: "tmux_proj_loop-supervisor",
      },
      timestamps: {
        scheduledAt: 1_000,
        startedAt: 2_000,
        endedAt: 3_000,
      },
      result: {
        status: "completed",
        output: "supervisor transcript",
        summary: {
          finalVerification: "passed",
          commits: ["abc123"],
        },
      },
    });
  });

  it("writes dispatch failure reports when no final summary is available", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-report-"));

    const report = writeLoopSupervisorReport({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 2_000,
      endedAt: 3_000,
      result: {
        status: "dispatch-failed",
        reason: "queue full",
        output: "partial output\nqueue full",
      },
    });

    const markdown = await readFile(report.markdownPath, "utf8");
    expect(markdown).toContain("- Status: dispatch-failed");
    expect(markdown).toContain("- No final supervisor summary was available.");
    expect(markdown).toContain("```text\npartial output\nqueue full\n```");

    expect(JSON.parse(await readFile(report.summaryPath, "utf8"))).toMatchObject({
      workOrderId: "wo-1",
      project: {
        id: "datavibe",
      },
      status: "dispatch-failed",
      supervisor: {
        session: "tmux_proj_loop-supervisor",
      },
      result: {
        status: "dispatch-failed",
        reason: "queue full",
        output: "partial output\nqueue full",
      },
    });
  });
});
