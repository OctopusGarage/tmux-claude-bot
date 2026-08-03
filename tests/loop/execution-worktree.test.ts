import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareLoopExecutionWorktrees } from "../../src/core/loop/execution-worktree.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "../../src/core/loop/run.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalStateDir = process.env.TCB_STATE_DIR;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-exec-worktree-repo-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

function workOrder(
  projectPath: string,
  taskKind: "architecture" | "opportunity-discovery" = "architecture",
): LoopWorkOrder {
  return {
    id: "run-1",
    scheduledAt: 1,
    task:
      taskKind === "opportunity-discovery"
        ? {
            kind: "opportunity-discovery",
            maxRounds: 1,
            maxSuggestions: 3,
            minConfidence: "medium",
            categories: ["developer-experience"],
            cooldownDays: 14,
            requireEvidence: true,
          }
        : { kind: "architecture" },
    projectId: "repo",
    projectName: "Repo",
    projectPath,
    executionIsolation: {
      mode: "supervised-worker",
      expectedWorktree: projectPath,
      worktreeIsolation: "auto",
      contextReset: "compact",
      cleanup: {
        success: "release-worker",
        failure: "retain-for-ttl",
        retainFailureForHours: 72,
      },
    },
    agent: "codex",
    goal: "Improve safely.",
    maxRounds: 1,
    targetScore: 95,
    runner: { kind: "agent-supervised", requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "true" },
    execution: { agent: true },
    recovery: { agent: true, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: false },
    pullRequestPolicy: {
      enabled: true,
      base: "main",
      switchBack: "main",
      autoMerge: false,
      mergeMethod: "squash",
    },
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:run-1]",
  };
}

function gitStub(
  sourceRoot: string,
  calls: LoopGitInvocation[],
  opts: { dirty?: boolean; syncFails?: boolean; worktreeAddFails?: boolean } = {},
): (invocation: LoopGitInvocation) => LoopRunCommandResult {
  return (invocation) => {
    calls.push(invocation);
    if (invocation.args.join(" ") === "rev-parse --show-toplevel") {
      if (invocation.cwd === sourceRoot)
        return { status: 0, stdout: `${sourceRoot}\n`, stderr: "" };
      return { status: 128, stdout: "", stderr: "not a git repository" };
    }
    if (invocation.args.join(" ") === "status --porcelain") {
      return { status: 0, stdout: opts.dirty === true ? "M src/index.ts\n" : "", stderr: "" };
    }
    if (invocation.args.join(" ") === "pull --rebase origin main") {
      if (opts.syncFails === true)
        return { status: 1, stdout: "", stderr: "cannot rebase: local divergence" };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (
      invocation.args.join(" ") === "fetch origin main" ||
      invocation.args.join(" ") === "switch main"
    ) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (invocation.args.slice(0, 3).join(" ") === "worktree add --detach") {
      if (opts.worktreeAddFails === true)
        return { status: 1, stdout: "", stderr: "worktree add failed" };
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

describe("prepareLoopExecutionWorktrees", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-exec-worktree-state-"));
  });

  afterEach(() => {
    const stateDir = process.env.TCB_STATE_DIR;
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = originalStateDir;
  });

  it("uses source worktree without creating a git worktree when source mode is requested", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls),
      defaultMode: "source",
    });

    expect(prepared.projectPath).toBe(repo);
    expect(prepared.executionIsolation).toMatchObject({
      expectedWorktree: repo,
      worktreeIsolation: "source",
      preparedBy: "source-worktree",
    });
    expect(calls.map((call) => call.args.join(" "))).toEqual(
      expect.arrayContaining([
        "status --porcelain",
        "fetch origin main",
        "switch main",
        "pull --rebase origin main",
      ]),
    );
    expect(calls.map((call) => call.args.join(" "))).not.toContain("worktree add --detach");
  });

  it("creates an isolated execution worktree by default", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls),
      defaultMode: "isolated",
    });

    expect(prepared.projectPath).toContain("loop-worktrees/repo/run-1");
    expect(prepared.executionIsolation).toMatchObject({
      sourceWorktree: repo,
      worktreeIsolation: "isolated",
      preparedBy: "system-git-worktree",
    });
    expect(calls.map((call) => call.args.join(" "))).toEqual(
      expect.arrayContaining([
        "status --porcelain",
        "fetch origin main",
        "switch main",
        "pull --rebase origin main",
      ]),
    );
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toContain("worktree add --detach");
  });

  it("reports an isolation preparation failure instead of silently using the source tree", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls, { worktreeAddFails: true }),
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
      },
    ]);
  });

  it("blocks execution worktree preparation when source branch sync finds a dirty tree", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls, { dirty: true }),
      defaultMode: "source",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls.map((call) => call.args.join(" "))).not.toContain("worktree add --detach");
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
      },
    ]);
  });

  it("blocks isolated worktree preparation when pull --rebase fails", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls, { syncFails: true }),
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls.map((call) => call.args.join(" "))).toContain("pull --rebase origin main");
    expect(calls.map((call) => call.args.join(" "))).not.toContain("worktree add --detach");
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
      },
    ]);
  });

  it("does not switch an explicitly source-isolated work order to an isolated worktree", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];
    const baseWorkOrder = workOrder(repo);
    if (baseWorkOrder.executionIsolation === undefined) {
      throw new Error("expected execution isolation in test fixture");
    }

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: {
        ...baseWorkOrder,
        executionIsolation: {
          ...baseWorkOrder.executionIsolation,
          worktreeIsolation: "source",
        },
      },
      runGit: gitStub(repo, calls, { dirty: true }),
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(prepared.executionIsolation?.worktreeIsolation).toBe("source");
    expect(prepared.executionIsolation?.preparedBy).toBeUndefined();
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).not.toContain(
      "worktree add --detach",
    );
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "source execution worktree could not be prepared",
      },
    ]);
  });

  it("lets read-only opportunity discovery use source mode when auto is requested", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo, "opportunity-discovery"),
      runGit: gitStub(repo, calls),
      defaultMode: "auto",
    });

    expect(prepared.projectPath).toBe(repo);
    expect(prepared.executionIsolation?.preparedBy).toBe("source-worktree");
    expect(calls.map((call) => call.args.join(" "))).not.toContain("worktree add --detach");
  });
});
