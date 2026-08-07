import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupLoopExecutionWorktree,
  prepareLoopExecutionWorktrees,
  restoreLoopExecutionWorktreeBranch,
} from "../../src/core/loop/execution-worktree.js";
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

describe("loop execution worktrees", () => {
  it("restores only a prepared bot-owned isolated worktree to its WorkOrder branch", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-restore-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const worktree = join(stateDir, "loop-worktrees", "hub", "run-1");
    mkdirSync(worktree, { recursive: true });
    const calls: LoopGitInvocation[] = [];
    const baseWorkOrder = workOrder(worktree);
    if (baseWorkOrder.executionIsolation === undefined) throw new Error("expected isolation");
    const order = {
      ...baseWorkOrder,
      commitPolicy: { enabled: true, perRound: false, branch: "loop/hub/run-1" },
      executionIsolation: {
        ...baseWorkOrder.executionIsolation,
        expectedWorktree: worktree,
        sourceWorktree: "/source/hub",
        worktreeIsolation: "isolated" as const,
        preparedBy: "system-git-worktree" as const,
      },
    } satisfies LoopWorkOrder;

    expect(
      restoreLoopExecutionWorktreeBranch({
        workOrder: order,
        runGit: (invocation) => {
          calls.push(invocation);
          if (invocation.args.join(" ") === "rev-parse --show-toplevel") {
            return { status: 0, stdout: `${worktree}\n`, stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).toEqual([]);
    expect(calls).toEqual([
      { cwd: worktree, args: ["rev-parse", "--show-toplevel"] },
      { cwd: worktree, args: ["switch", "loop/hub/run-1"] },
    ]);
  });

  it("does not restore a source or unprepared worktree", () => {
    const repo = makeRepo();
    const runGit = () => {
      throw new Error("source worktree must not be switched");
    };

    expect(restoreLoopExecutionWorktreeBranch({ workOrder: workOrder(repo), runGit })).toEqual([]);
  });

  it("refuses a prepared worktree when its persisted expected path differs", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-restore-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const worktree = join(stateDir, "loop-worktrees", "hub", "run-1");
    mkdirSync(worktree, { recursive: true });
    const baseWorkOrder = workOrder(worktree);
    if (baseWorkOrder.executionIsolation === undefined) throw new Error("expected isolation");
    const order = {
      ...baseWorkOrder,
      commitPolicy: { enabled: true, perRound: false, branch: "loop/hub/run-1" },
      executionIsolation: {
        ...baseWorkOrder.executionIsolation,
        expectedWorktree: join(stateDir, "loop-worktrees", "hub", "other-run"),
        sourceWorktree: "/source/hub",
        worktreeIsolation: "isolated" as const,
        preparedBy: "system-git-worktree" as const,
      },
    } satisfies LoopWorkOrder;

    expect(
      restoreLoopExecutionWorktreeBranch({
        workOrder: order,
        runGit: () => {
          throw new Error("mismatched worktree must not be touched");
        },
      }),
    ).toEqual([]);
  });

  it("removes only an expired bot-owned isolated worktree", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-cleanup-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const worktree = join(stateDir, "loop-worktrees", "hub", "failed-run");
    mkdirSync(worktree, { recursive: true });
    const calls: string[] = [];

    const removed = cleanupLoopExecutionWorktree({
      worktree,
      runGit: (invocation) => {
        calls.push(`${invocation.cwd}:${invocation.args.join(" ")}`);
        if (invocation.args[0] === "rev-parse") {
          return { status: 0, stdout: `${worktree}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(removed).toBe(true);
    expect(calls).toEqual([
      `${worktree}:rev-parse --show-toplevel`,
      `${worktree}:worktree remove --force ${worktree}`,
    ]);
  });

  it("refuses source and outside paths before invoking destructive git commands", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-cleanup-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const runGit = () => {
      throw new Error("destructive git command must not run");
    };

    expect(cleanupLoopExecutionWorktree({ worktree: join(stateDir, "source"), runGit })).toBe(
      false,
    );
    expect(
      cleanupLoopExecutionWorktree({ worktree: join(stateDir, "other", "repo"), runGit }),
    ).toBe(false);
  });

  it("treats an already removed bot worktree as cleaned", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-cleanup-state-"));
    process.env.TCB_STATE_DIR = stateDir;

    expect(
      cleanupLoopExecutionWorktree({
        worktree: join(stateDir, "loop-worktrees", "hub", "already-removed"),
        runGit: () => {
          throw new Error("git must not run for a missing worktree");
        },
      }),
    ).toBe(true);
  });

  it("keeps the lease eligible for retry when git validation or removal fails", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-cleanup-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const worktree = join(stateDir, "loop-worktrees", "hub", "failed-cleanup");
    mkdirSync(worktree, { recursive: true });

    expect(
      cleanupLoopExecutionWorktree({
        worktree,
        runGit: () => ({ status: 1, stdout: "", stderr: "not a worktree" }),
      }),
    ).toBe(false);
    expect(
      cleanupLoopExecutionWorktree({
        worktree,
        runGit: (invocation) =>
          invocation.args[0] === "rev-parse"
            ? { status: 0, stdout: `${worktree}\n`, stderr: "" }
            : { status: 1, stdout: "", stderr: "busy" },
      }),
    ).toBe(false);
  });
});

function gitStub(
  sourceRoot: string,
  calls: LoopGitInvocation[],
  opts: {
    dirty?: boolean;
    statusFails?: boolean;
    fetchFails?: boolean;
    worktreeAddFails?: boolean;
  } = {},
): (invocation: LoopGitInvocation) => LoopRunCommandResult {
  return (invocation) => {
    calls.push(invocation);
    if (invocation.args.join(" ") === "rev-parse --show-toplevel") {
      if (invocation.cwd === sourceRoot)
        return { status: 0, stdout: `${sourceRoot}\n`, stderr: "" };
      return { status: 128, stdout: "", stderr: "not a git repository" };
    }
    if (invocation.args.join(" ") === "status --porcelain") {
      if (opts.statusFails === true) {
        return { status: 1, stdout: "", stderr: "fatal: not a repository" };
      }
      return { status: 0, stdout: opts.dirty === true ? "M src/index.ts\n" : "", stderr: "" };
    }
    if (invocation.args.join(" ") === "fetch origin main" && opts.fetchFails === true) {
      return { status: 1, stdout: "", stderr: "fatal: repository not found" };
    }
    if (invocation.args.join(" ") === "pull --rebase origin main") {
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

function gitStubWithUnavailableRemote(sourceRoot: string, calls: LoopGitInvocation[]) {
  return (invocation: LoopGitInvocation): LoopRunCommandResult => {
    calls.push(invocation);
    const command = invocation.args.join(" ");
    if (command === "rev-parse --show-toplevel") {
      return { status: 0, stdout: `${sourceRoot}\n`, stderr: "" };
    }
    if (command === "status --porcelain") return { status: 0, stdout: "", stderr: "" };
    if (command === "fetch origin main") {
      return { status: 1, stdout: "", stderr: "Connection closed by remote host" };
    }
    if (command === "rev-parse --verify refs/heads/main") {
      return { status: 0, stdout: "local-commit\n", stderr: "" };
    }
    if (command === "switch main") return { status: 0, stdout: "", stderr: "" };
    if (command === "worktree add --detach") return { status: 0, stdout: "", stderr: "" };
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
      expect.arrayContaining(["status --porcelain", "fetch origin main"]),
    );
    expect(calls.map((call) => call.args.join(" "))).not.toContain("switch main");
    expect(calls.map((call) => call.args.join(" "))).not.toContain("pull --rebase origin main");
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toContain("worktree add --detach");
  });

  it("checks out the required WorkOrder branch before dispatching an isolated worker", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];

    prepareLoopExecutionWorktrees({
      workOrder: {
        ...workOrder(repo),
        commitPolicy: { enabled: true, perRound: false, branch: "loop/repo/run-1" },
      },
      runGit: gitStub(repo, calls),
      defaultMode: "isolated",
    });

    const executionWorktree = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-worktrees",
      "repo",
      "run-1",
    );
    expect(calls).toContainEqual({
      cwd: executionWorktree,
      args: ["switch", "-C", "loop/repo/run-1", "origin/main"],
    });
  });

  it("uses a verified local branch when remote fetch is unavailable", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStubWithUnavailableRemote(repo, calls),
      defaultMode: "isolated",
    });

    expect(prepared.projectPath).toContain("loop-worktrees/repo/run-1");
    expect(calls.map((call) => call.args.join(" "))).toContain(
      "rev-parse --verify refs/heads/main",
    );
    expect(calls.map((call) => call.args.join(" "))).not.toContain("pull --rebase origin main");
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
        detail: "worktree add failed",
        repairDisposition: "bot-repairable",
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
        detail: "source worktree is dirty: M src/index.ts",
        repairDisposition: "target-or-external-blocker",
      },
    ]);
  });

  it("blocks isolated preparation when base fetch fails without mutating source", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls, { fetchFails: true }),
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls.map((call) => call.args.join(" "))).not.toContain("switch main");
    expect(calls.map((call) => call.args.join(" "))).not.toContain("pull --rebase origin main");
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).not.toContain(
      "worktree add --detach",
    );
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
        detail: "fatal: repository not found",
        repairDisposition: "bot-repairable",
      },
    ]);
  });

  it("blocks isolated worktree preparation when the source is dirty", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls, { dirty: true }),
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls.map((call) => call.args.join(" "))).not.toContain("fetch origin main");
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
        detail: "source worktree is dirty: M src/index.ts",
        repairDisposition: "target-or-external-blocker",
      },
    ]);
  });

  it("blocks isolated worktree preparation when source status cannot be read", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStub(repo, calls, { statusFails: true }),
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls.map((call) => call.args.join(" "))).not.toContain("fetch origin main");
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
        detail: "fatal: not a repository",
        repairDisposition: "bot-repairable",
      },
    ]);
  });

  it("uses HEAD for isolated work when no base branch is configured", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const baseWorkOrder = workOrder(repo);
    const { pullRequestPolicy: _pullRequestPolicy, ...workOrderWithoutBase } = baseWorkOrder;

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrderWithoutBase,
      runGit: gitStub(repo, calls),
      defaultMode: "isolated",
    });

    expect(prepared.projectPath).toContain("loop-worktrees/repo/run-1");
    expect(calls.map((call) => call.args.join(" "))).not.toContain("fetch origin main");
    expect(calls).toContainEqual({
      cwd: repo,
      args: ["worktree", "add", "--detach", prepared.projectPath, "HEAD"],
    });
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
        repairDisposition: "bot-repairable",
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
