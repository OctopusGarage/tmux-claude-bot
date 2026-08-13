import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoopBacklogStore } from "../../src/core/loop/backlog.js";
import { listLoopReports, writeLoopRunReport } from "../../src/core/loop/report.js";
import type { LoopRunSummary } from "../../src/core/loop/run.js";
import { writeLoopSupervisorReport } from "../../src/core/loop/supervisor-report.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function summary(overrides: Partial<LoopRunSummary> = {}): LoopRunSummary {
  const base: LoopRunSummary = {
    phase: "command-run",
    projectId: "hub",
    projectName: "Hub",
    status: "passed",
    executed: 1,
    committed: false,
    rounds: [],
    commands: [
      {
        kind: "assessment",
        command: "npm run assess",
        cwd: "/repo/hub",
        env: {},
        status: 0,
        stdout: "ok",
        stderr: "",
      },
    ],
    evalResult: null,
    skills: {
      approved: [
        {
          id: "improve-codebase-architecture",
          sourceUrl: "https://github.com/mattpocock/skills",
          sourcePath: "skills/engineering/improve-codebase-architecture",
          ref: "2f3c4d5e6a",
          checksum: "sha256:abc",
          platforms: ["claude", "codex"],
          tags: ["architecture"],
          trustLevel: "approved",
          risk: "medium",
          updatePolicy: "notify",
        },
      ],
    },
    suggestedBotImprovements: ["Make loop failures easier to inspect."],
  };
  return {
    ...base,
    ...overrides,
    evalResult: overrides.evalResult ?? base.evalResult,
  };
}

describe("loop reports and backlog", () => {
  it("writes markdown and JSON run reports under the state directory", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-report-"));

    const report = writeLoopRunReport(summary(), {
      runId: "run-1",
      startedAt: 1_000,
      endedAt: 2_000,
    });

    expect(report).toMatchObject({
      runId: "run-1",
      projectId: "hub",
      status: "passed",
    });
    await expect(readFile(report.markdownPath, "utf8")).resolves.toContain("# Loop Run: Hub");
    await expect(readFile(report.markdownPath, "utf8")).resolves.toContain(
      "improve-codebase-architecture",
    );
    await expect(readFile(report.markdownPath, "utf8")).resolves.toContain("2f3c4d5e6a");
    await expect(readFile(report.summaryPath, "utf8")).resolves.toContain('"projectId": "hub"');
    await expect(readFile(report.summaryPath, "utf8")).resolves.toContain(
      '"checksum": "sha256:abc"',
    );
    expect(listLoopReports()).toEqual([expect.objectContaining({ runId: "run-1" })]);
  });

  it("lists supervisor reports alongside command-backed loop reports", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-report-"));
    const workOrder = {
      id: "wo-1",
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
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:wo-1]",
    } satisfies LoopWorkOrder;

    writeLoopSupervisorReport({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 2_000,
      endedAt: 3_000,
      result: {
        status: "completed",
        output: "ok",
        summary: {
          status: "completed",
          projectId: "hub",
          actionsTaken: [],
          delegatedTasks: [],
          finalVerification: "passed",
          commits: [],
          followUps: [],
        },
      },
    });

    expect(listLoopReports()).toEqual([
      expect.objectContaining({
        runId: "wo-1",
        projectId: "hub",
        projectName: "Hub",
        status: "passed",
        startedAt: 2_000,
        endedAt: 3_000,
      }),
    ]);
  });

  it("dedupes suggested bot improvements and closes backlog items", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-backlog-"));
    const store = new LoopBacklogStore();

    const [first] = store.addSuggestions(summary(), 1_000);
    const duplicate = store.addSuggestions(summary(), 2_000);

    expect(first).toMatchObject({
      projectId: "hub",
      status: "open",
      text: "Make loop failures easier to inspect.",
    });
    expect(duplicate).toEqual([]);
    expect(store.list()).toHaveLength(1);
    expect(store.close(first?.id ?? "", 3_000)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.list({ all: true })).toEqual([
      expect.objectContaining({ id: first?.id, status: "closed", closedAt: 3_000 }),
    ]);
  });

  it("bounds and filters backlog queries while preserving the reconciliation list", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-backlog-query-"));
    const store = new LoopBacklogStore();
    store.addFollowUps("alpha", ["first", "second"], 1_000, "run-a");
    store.addFollowUps("beta", ["third"], 2_000, "run-b");

    expect(store.query({ projectId: "alpha", limit: 1 })).toEqual({
      items: [expect.objectContaining({ projectId: "alpha" })],
      total: 2,
      limit: 1,
      truncated: true,
    });
    expect(store.list()).toHaveLength(3);
  });
});
