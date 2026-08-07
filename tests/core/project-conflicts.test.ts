import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findProjectAutomationConflict,
  findProjectAutomationConflictForSession,
} from "../../src/core/automation/project-conflicts.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { setPathForSession } from "../../src/core/projects/sessionPathMap.js";

let oldStateDir: string | undefined;
let stateDir: string;
let sourceDir: string;
let isolatedDir: string;

beforeEach(() => {
  oldStateDir = process.env.TCB_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "tcb-project-conflicts-state-"));
  sourceDir = mkdtempSync(join(tmpdir(), "tcb-project-conflicts-source-"));
  isolatedDir = mkdtempSync(join(tmpdir(), "tcb-project-conflicts-isolated-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(isolatedDir, { recursive: true, force: true });
  if (oldStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = oldStateDir;
});

function writeWorkOrder(input: {
  id: string;
  projectPath: string;
  sourceWorktree?: string;
  worktreeIsolation: "isolated" | "source";
}): void {
  writeLoopSupervisorWorkOrderState({
    workOrder: {
      id: input.id,
      scheduledAt: Date.now(),
      projectId: "tmux-claude-bot",
      projectName: "tmux-claude-bot",
      projectPath: input.projectPath,
      task: { kind: "bug-fix", maxRounds: 1, maxBugsPerRound: 1, requireRegressionTest: true },
      executionIsolation: {
        mode: "supervised-worker",
        expectedWorktree: input.projectPath,
        worktreeIsolation: input.worktreeIsolation,
        contextReset: "compact",
        cleanup: {
          success: "release-worker",
          failure: "retain-for-ttl",
          retainFailureForHours: 72,
        },
        ...(input.sourceWorktree === undefined ? {} : { sourceWorktree: input.sourceWorktree }),
      },
      agent: "codex",
      goal: "test",
      maxRounds: 1,
      targetScore: 95,
      runner: { kind: "agent-supervised" },
      allowedActions: [],
      blockedActions: [],
      skills: { approved: [] },
      preflight: { commands: [] },
      assessment: { command: "true", timeoutMs: 1000 },
      execution: { command: "true", timeoutMs: 1000 },
      recovery: { maxAttempts: 0 },
      commitPolicy: { enabled: false },
      requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${input.id}]`,
    } as unknown as LoopWorkOrder,
    supervisorSession: "tmux_proj_loop-supervisor-1",
    status: "in-flight",
    now: Date.now(),
  });
}

describe("project automation conflicts", () => {
  it("does not block ordinary source-session messages for an isolated worktree run", () => {
    setPathForSession("source-session", sourceDir);
    writeWorkOrder({
      id: "isolated-run",
      projectPath: isolatedDir,
      sourceWorktree: sourceDir,
      worktreeIsolation: "isolated",
    });

    expect(findProjectAutomationConflictForSession("source-session")).toBeNull();
    expect(findProjectAutomationConflict(sourceDir)).toMatchObject({
      runId: "isolated-run",
      projectPath: isolatedDir,
    });
    expect(findProjectAutomationConflict(isolatedDir)).toMatchObject({
      runId: "isolated-run",
      projectPath: isolatedDir,
    });
  });

  it("blocks ordinary source-session messages when the run owns the source worktree", () => {
    setPathForSession("source-session", sourceDir);
    writeWorkOrder({
      id: "source-run",
      projectPath: sourceDir,
      sourceWorktree: sourceDir,
      worktreeIsolation: "source",
    });

    expect(findProjectAutomationConflictForSession("source-session")).toMatchObject({
      runId: "source-run",
      projectPath: sourceDir,
    });
  });

  it("does not reserve a work order after its final summary is already present", () => {
    const summaryDir = join(stateDir, "loop-runs", "completed-run");
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: {
        id: "completed-run",
        scheduledAt: Date.now(),
        projectId: "tmux-claude-bot",
        projectName: "tmux-claude-bot",
        projectPath: sourceDir,
        agent: "codex",
        goal: "test",
        maxRounds: 1,
        targetScore: 95,
        runner: { kind: "agent-supervised" },
        allowedActions: [],
        blockedActions: [],
        skills: { approved: [] },
        preflight: { commands: [] },
        assessment: { command: "true" },
        execution: { agent: true },
        recovery: { maxAttempts: 0 },
        commitPolicy: { enabled: false },
        requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:completed-run]",
        finalSummaryPath,
      } as unknown as LoopWorkOrder,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      finalSummaryPath,
      JSON.stringify({
        status: "completed",
        projectId: "tmux-claude-bot",
        actionsTaken: ["done"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      }),
    );

    expect(findProjectAutomationConflict(sourceDir)).toBeNull();
  });
});
