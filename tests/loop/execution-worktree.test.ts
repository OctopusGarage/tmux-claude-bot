import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupLoopExecutionWorktree,
  prepareLoopExecutionWorktrees,
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

  it("removes a missing bot worktree's stale Git registration from its source repository", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-cleanup-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const sourceWorktree = join(stateDir, "source");
    mkdirSync(sourceWorktree, { recursive: true });
    const worktree = join(stateDir, "loop-worktrees", "hub", "already-removed");
    const calls: string[] = [];

    expect(
      cleanupLoopExecutionWorktree({
        worktree,
        sourceWorktree,
        runGit: (invocation) => {
          calls.push(`${invocation.cwd}:${invocation.args.join(" ")}`);
          if (invocation.args[0] === "rev-parse") {
            return { status: 0, stdout: `${sourceWorktree}\n`, stderr: "" };
          }
          if (invocation.args.join(" ") === "worktree list --porcelain") {
            return {
              status: 0,
              stdout: `worktree ${sourceWorktree}\n\nworktree ${worktree}\nprunable gitdir file points to non-existent location\n`,
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([
      `${sourceWorktree}:rev-parse --show-toplevel`,
      `${sourceWorktree}:worktree list --porcelain`,
      `${sourceWorktree}:worktree remove --force ${worktree}`,
    ]);
  });

  it("treats a missing unregistered bot worktree as already reconciled", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-cleanup-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const sourceWorktree = join(stateDir, "source");
    mkdirSync(sourceWorktree, { recursive: true });
    const worktree = join(stateDir, "loop-worktrees", "hub", "already-pruned");
    const calls: string[] = [];

    expect(
      cleanupLoopExecutionWorktree({
        worktree,
        sourceWorktree,
        runGit: (invocation) => {
          calls.push(`${invocation.cwd}:${invocation.args.join(" ")}`);
          if (invocation.args[0] === "rev-parse") {
            return { status: 0, stdout: `${sourceWorktree}\n`, stderr: "" };
          }
          if (invocation.args.join(" ") === "worktree list --porcelain") {
            return { status: 0, stdout: `worktree ${sourceWorktree}\n`, stderr: "" };
          }
          throw new Error("an absent registration must not be removed again");
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([
      `${sourceWorktree}:rev-parse --show-toplevel`,
      `${sourceWorktree}:worktree list --porcelain`,
    ]);
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

function workspaceGitStub(
  sourceRoots: string[],
  calls: LoopGitInvocation[],
  opts: { dirtyRoot?: string; fetchFailureRoot?: string } = {},
): (invocation: LoopGitInvocation) => LoopRunCommandResult {
  return (invocation) => {
    calls.push(invocation);
    const command = invocation.args.join(" ");
    if (command === "rev-parse --show-toplevel") {
      if (sourceRoots.includes(invocation.cwd)) {
        return { status: 0, stdout: `${invocation.cwd}\n`, stderr: "" };
      }
      return { status: 128, stdout: "", stderr: "not a git repository" };
    }
    if (command === "status --porcelain") {
      return {
        status: 0,
        stdout: invocation.cwd === opts.dirtyRoot ? "M package.json\n" : "",
        stderr: "",
      };
    }
    if (command.startsWith("fetch origin ")) {
      if (invocation.cwd === opts.fetchFailureRoot) {
        return { status: 1, stdout: "", stderr: "fatal: repository not found" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command.startsWith("switch ") || command.startsWith("pull --rebase origin ")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (invocation.args.slice(0, 3).join(" ") === "worktree add --detach") {
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
      expect.arrayContaining(["status --porcelain", "fetch origin main"]),
    );
    expect(calls.map((call) => call.args.join(" "))).not.toContain("switch main");
    expect(calls.map((call) => call.args.join(" "))).not.toContain("pull --rebase origin main");
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toContain("worktree add --detach");
  });

  it("repairs a normal source checkout misconfigured as bare before isolation", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    let bare = true;

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: (invocation) => {
        calls.push(invocation);
        const command = invocation.args.join(" ");
        if (command === "rev-parse --show-toplevel") {
          return bare
            ? {
                status: 128,
                stdout: "",
                stderr: "fatal: this operation must be run in a work tree",
              }
            : { status: 0, stdout: `${invocation.cwd}\n`, stderr: "" };
        }
        if (command.endsWith("config --bool --get core.bare")) {
          return { status: 0, stdout: bare ? "true\n" : "false\n", stderr: "" };
        }
        if (command.endsWith("config core.bare false")) {
          bare = false;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "status --porcelain" || command === "fetch origin main") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.slice(0, 3).join(" ") === "worktree add --detach") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      defaultMode: "isolated",
    });

    expect(bare).toBe(false);
    expect(prepared.projectPath).toContain("loop-worktrees/repo/run-1");
    expect(calls.map((call) => call.args.join(" "))).toEqual(
      expect.arrayContaining([
        `--git-dir ${join(repo, ".git")} config --bool --get core.bare`,
        `--git-dir ${join(repo, ".git")} config core.bare false`,
      ]),
    );
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

  it("resets a reused isolated worktree onto the WorkOrder branch before dispatch", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];
    const executionWorktree = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-worktrees",
      "repo",
      "run-1",
    );
    mkdirSync(executionWorktree, { recursive: true });

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: {
        ...workOrder(repo),
        commitPolicy: { enabled: true, perRound: false, branch: "loop/repo/run-1" },
      },
      runGit: (invocation) => {
        calls.push(invocation);
        const command = invocation.args.join(" ");
        if (command === "rev-parse --show-toplevel") {
          if (invocation.cwd === repo) return { status: 0, stdout: `${repo}\n`, stderr: "" };
          if (invocation.cwd === executionWorktree) {
            return { status: 0, stdout: `${executionWorktree}\n`, stderr: "" };
          }
        }
        if (command === "status --porcelain") return { status: 0, stdout: "", stderr: "" };
        if (command === "fetch origin main") return { status: 0, stdout: "", stderr: "" };
        if (command === "switch loop/repo/run-1") {
          return { status: 128, stdout: "", stderr: "fatal: invalid reference: loop/repo/run-1" };
        }
        if (command === "switch -C loop/repo/run-1 origin/main") {
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git args: ${command}`);
      },
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(executionWorktree);
    expect(failures).toEqual([]);
    expect(calls).toContainEqual({
      cwd: executionWorktree,
      args: ["switch", "-C", "loop/repo/run-1", "origin/main"],
    });
    expect(calls).not.toContainEqual({
      cwd: executionWorktree,
      args: ["switch", "loop/repo/run-1"],
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

  it("uses a verified local branch for source mode when remote fetch is unavailable", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: gitStubWithUnavailableRemote(repo, calls),
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
        "fetch origin main",
        "rev-parse --verify refs/heads/main",
        "switch main",
      ]),
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

  it("reports explicit source isolation failure for a non-git project path", () => {
    const repo = mkdtempSync(join(tmpdir(), "tcb-exec-worktree-not-git-"));
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
      runGit: () => {
        throw new Error("git must not run for a path without .git");
      },
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "source execution worktree could not be prepared",
        repairDisposition: "bot-repairable",
      },
    ]);
  });

  it("reports source isolation failure when git top-level cannot be verified", () => {
    const repo = makeRepo();
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
      runGit: (invocation) =>
        invocation.args.join(" ") === "rev-parse --show-toplevel"
          ? { status: 128, stdout: "", stderr: "rev-parse failed" }
          : { status: 0, stdout: "", stderr: "" },
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "source execution worktree could not be prepared",
        repairDisposition: "bot-repairable",
      },
    ]);
  });

  it("blocks source isolation when pull --rebase fails after a successful fetch and switch", () => {
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
      runGit: (invocation) => {
        calls.push(invocation);
        const command = invocation.args.join(" ");
        if (command === "rev-parse --show-toplevel") {
          return { status: 0, stdout: `${repo}\n`, stderr: "" };
        }
        if (command === "status --porcelain") return { status: 0, stdout: "", stderr: "" };
        if (command === "fetch origin main") return { status: 0, stdout: "", stderr: "" };
        if (command === "switch main") return { status: 0, stdout: "", stderr: "" };
        if (command === "pull --rebase origin main") {
          return { status: 1, stdout: "", stderr: "conflict during rebase" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls.map((call) => call.args.join(" "))).toEqual(
      expect.arrayContaining(["fetch origin main", "switch main", "pull --rebase origin main"]),
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

  it("fails isolated preparation when remote is unavailable and the local base branch is missing", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: workOrder(repo),
      runGit: (invocation) => {
        calls.push(invocation);
        const command = invocation.args.join(" ");
        if (command === "rev-parse --show-toplevel") {
          return { status: 0, stdout: `${repo}\n`, stderr: "" };
        }
        if (command === "status --porcelain") return { status: 0, stdout: "", stderr: "" };
        if (command === "fetch origin main") {
          return { status: 1, stdout: "", stderr: "Could not resolve host: github.com" };
        }
        if (command === "rev-parse --verify refs/heads/main") {
          return { status: 128, stdout: "", stderr: "unknown revision" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls.map((call) => call.args.join(" "))).toContain(
      "rev-parse --verify refs/heads/main",
    );
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).not.toContain(
      "worktree add --detach",
    );
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
        detail: "Could not resolve host: github.com",
        repairDisposition: "bot-repairable",
      },
    ]);
  });

  it("reports branch switch failure when reusing an existing isolated worktree", () => {
    const repo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];
    const executionWorktree = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-worktrees",
      "repo",
      "run-1",
    );
    mkdirSync(executionWorktree, { recursive: true });

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: {
        ...workOrder(repo),
        commitPolicy: { enabled: true, perRound: false, branch: "loop/repo/run-1" },
      },
      runGit: (invocation) => {
        calls.push(invocation);
        const command = invocation.args.join(" ");
        if (command === "rev-parse --show-toplevel") {
          if (invocation.cwd === repo) return { status: 0, stdout: `${repo}\n`, stderr: "" };
          if (invocation.cwd === executionWorktree) {
            return { status: 0, stdout: `${executionWorktree}\n`, stderr: "" };
          }
        }
        if (command === "status --porcelain") return { status: 0, stdout: "", stderr: "" };
        if (command === "fetch origin main") return { status: 0, stdout: "", stderr: "" };
        if (command === "switch -C loop/repo/run-1 origin/main") {
          return { status: 1, stdout: "", stderr: "branch not found" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.projectPath).toBe(repo);
    expect(calls).toContainEqual({
      cwd: executionWorktree,
      args: ["switch", "-C", "loop/repo/run-1", "origin/main"],
    });
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).not.toContain(
      "worktree add --detach",
    );
    expect(failures).toEqual([
      {
        repositoryId: "repo",
        sourceWorktree: repo,
        reason: "isolated execution worktree could not be prepared",
        detail: "branch not found",
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

  it("prepares each workspace repository with its own isolation policy", () => {
    const apiRepo = makeRepo();
    const docsRepo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const base = workOrder(apiRepo);

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: {
        ...base,
        task: { kind: "workspace-architecture" },
        workspace: {
          root: join(tmpdir(), "workspace-root"),
          repositories: [
            {
              id: "api",
              name: "API",
              path: apiRepo,
              role: "backend",
              agent: "codex",
              pullRequest: {
                enabled: true,
                base: "main",
                switchBack: "main",
                autoMerge: false,
                mergeMethod: "squash",
              },
            },
            {
              id: "docs",
              name: "Docs",
              path: docsRepo,
              worktreeIsolation: "source",
              role: "documentation",
              agent: "codex",
              pullRequest: {
                enabled: true,
                base: "docs-main",
                switchBack: "docs-main",
                autoMerge: false,
                mergeMethod: "squash",
              },
            },
          ],
        },
      },
      runGit: workspaceGitStub([apiRepo, docsRepo], calls),
      defaultMode: "isolated",
    });

    expect(prepared.workspace?.repositories).toMatchObject([
      {
        id: "api",
        path: join(process.env.TCB_STATE_DIR ?? "", "loop-worktrees", "repo", "run-1", "api"),
        sourcePath: apiRepo,
        worktreeIsolation: "isolated",
      },
      {
        id: "docs",
        path: docsRepo,
        worktreeIsolation: "source",
      },
    ]);
    expect(calls).toContainEqual({
      cwd: apiRepo,
      args: [
        "worktree",
        "add",
        "--detach",
        join(process.env.TCB_STATE_DIR ?? "", "loop-worktrees", "repo", "run-1", "api"),
        "origin/main",
      ],
    });
    expect(calls.map((call) => `${call.cwd}:${call.args.join(" ")}`)).toEqual(
      expect.arrayContaining([
        `${docsRepo}:fetch origin docs-main`,
        `${docsRepo}:switch docs-main`,
        `${docsRepo}:pull --rebase origin docs-main`,
      ]),
    );
  });

  it("keeps a failed workspace repository on its source path and reports that repository only", () => {
    const apiRepo = makeRepo();
    const docsRepo = makeRepo();
    const calls: LoopGitInvocation[] = [];
    const failures: unknown[] = [];
    const base = workOrder(apiRepo);
    const pullRequest = base.pullRequestPolicy;
    if (pullRequest === undefined) throw new Error("expected pull request policy in fixture");

    const prepared = prepareLoopExecutionWorktrees({
      workOrder: {
        ...base,
        task: { kind: "workspace-architecture" },
        workspace: {
          root: join(tmpdir(), "workspace-root"),
          repositories: [
            {
              id: "api",
              name: "API",
              path: apiRepo,
              role: "backend",
              agent: "codex",
              pullRequest,
            },
            {
              id: "docs",
              name: "Docs",
              path: docsRepo,
              role: "documentation",
              agent: "codex",
              pullRequest,
            },
          ],
        },
      },
      runGit: workspaceGitStub([apiRepo, docsRepo], calls, { dirtyRoot: docsRepo }),
      defaultMode: "isolated",
      onPreparationFailure: (failure) => failures.push(failure),
    });

    expect(prepared.workspace?.repositories.find((repo) => repo.id === "api")).toMatchObject({
      id: "api",
      sourcePath: apiRepo,
      worktreeIsolation: "isolated",
    });
    expect(prepared.workspace?.repositories.find((repo) => repo.id === "docs")).toMatchObject({
      id: "docs",
      path: docsRepo,
    });
    expect(failures).toEqual([
      {
        repositoryId: "docs",
        sourceWorktree: docsRepo,
        reason: "isolated execution worktree could not be prepared",
        detail: "source worktree is dirty: M package.json",
        repairDisposition: "target-or-external-blocker",
      },
    ]);
  });
});
