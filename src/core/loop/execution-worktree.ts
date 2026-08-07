import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import {
  type LoopWorkOrder,
  type LoopWorktreeIsolationMode,
  withLoopExecutionWorktree,
  withLoopSourceWorktree,
  withLoopWorkspaceRepositoryExecutionWorktrees,
} from "./work-order.js";

const log = createLogger("loop.execution-worktree");

export function prepareLoopExecutionWorktrees(input: {
  workOrder: LoopWorkOrder;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  defaultMode?: LoopWorktreeIsolationMode;
  onPreparationFailure?: (failure: LoopExecutionWorktreePreparationFailure) => void;
}): LoopWorkOrder {
  if (input.runGit === undefined) return input.workOrder;
  if (input.workOrder.workspace !== undefined) {
    return prepareWorkspaceExecutionWorktrees(
      input.workOrder,
      input.runGit,
      input.defaultMode,
      input.onPreparationFailure,
    );
  }
  const isolation = resolveWorktreeIsolationMode(input.workOrder, input.defaultMode);
  if (isolation.mode === "source") {
    const source = prepareSourceExecutionWorktree({
      runGit: input.runGit,
      sourceWorktree: input.workOrder.projectPath,
      workOrder: input.workOrder,
    });
    if (source !== null) return source;
    if (isolation.requested === "source") {
      return failExecutionWorktreePreparation(input, {
        repositoryId: input.workOrder.projectId,
        sourceWorktree: input.workOrder.projectPath,
        reason: "source execution worktree could not be prepared",
      });
    }
  }
  const prepared = prepareGitExecutionWorktree({
    runGit: input.runGit,
    sourceWorktree: input.workOrder.projectPath,
    workOrder: input.workOrder,
  });
  if (prepared === null) {
    return looksLikeGitWorktree(input.workOrder.projectPath)
      ? failExecutionWorktreePreparation(input, {
          repositoryId: input.workOrder.projectId,
          sourceWorktree: input.workOrder.projectPath,
          reason: "isolated execution worktree could not be prepared",
        })
      : input.workOrder;
  }
  if ("detail" in prepared) {
    return failExecutionWorktreePreparation(input, {
      repositoryId: input.workOrder.projectId,
      sourceWorktree: input.workOrder.projectPath,
      reason: "isolated execution worktree could not be prepared",
      detail: prepared.detail,
    });
  }
  return withLoopExecutionWorktree(input.workOrder, prepared.executionWorktree);
}

/**
 * Remove an isolated execution worktree after its retention window expires.
 *
 * Only paths created below this bot's state-owned loop-worktrees directory are
 * eligible. The git toplevel check is deliberately repeated before removal so
 * a stale lease can never turn into a destructive command against a configured
 * source repository.
 */
export function cleanupLoopExecutionWorktree(input: {
  worktree: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): boolean {
  const worktree = resolvePath(input.worktree);
  if (!isBotOwnedLoopExecutionWorktree(worktree)) {
    log.warn("loop refused to remove worktree outside bot-owned state", {
      data: { worktree },
    });
    return false;
  }
  if (!existsSync(worktree)) return true;
  const topLevel = input.runGit({ cwd: worktree, args: ["rev-parse", "--show-toplevel"] });
  if (topLevel.status !== 0 || resolvePath(topLevel.stdout.trim()) !== worktree) {
    log.warn("loop refused to remove path that is not the expected git worktree", {
      data: {
        worktree,
        reason: topLevel.stderr || topLevel.stdout || "git toplevel verification failed",
      },
    });
    return false;
  }
  const removed = input.runGit({
    cwd: worktree,
    args: ["worktree", "remove", "--force", worktree],
  });
  if (removed.status !== 0) {
    log.warn("loop failed to remove expired isolated worktree", {
      data: {
        worktree,
        reason: removed.stderr || removed.stdout || "git worktree remove failed",
      },
    });
    return false;
  }
  log.info("loop removed expired isolated worktree", { data: { worktree } });
  return true;
}

export function isBotOwnedLoopExecutionWorktree(worktree: string): boolean {
  const root = resolvePath(join(appStateDir(), "loop-worktrees"));
  const resolved = resolvePath(worktree);
  return resolved !== root && resolved.startsWith(`${root}/`);
}

export type LoopExecutionWorktreePreparationFailure = {
  repositoryId: string;
  sourceWorktree: string;
  reason: string;
  detail?: string;
};

function prepareWorkspaceExecutionWorktrees(
  workOrder: LoopWorkOrder,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
  defaultMode?: LoopWorktreeIsolationMode,
  onPreparationFailure?: (failure: LoopExecutionWorktreePreparationFailure) => void,
): LoopWorkOrder {
  const workspace = workOrder.workspace;
  if (workspace === undefined) return workOrder;
  const replacements: Array<{
    id: string;
    path: string;
    sourcePath?: string;
    worktreeIsolation?: LoopWorktreeIsolationMode;
  }> = workspace.repositories.map((repository) => {
    const isolation = resolveRepositoryWorktreeIsolationMode(workOrder, repository, defaultMode);
    if (isolation.mode === "source") {
      const prepared = prepareSourceExecutionWorktree({
        runGit,
        sourceWorktree: repository.path,
        workOrder,
        repositoryId: repository.id,
      });
      if (prepared !== null) {
        return {
          id: repository.id,
          path:
            prepared.workspace?.repositories.find((candidate) => candidate.id === repository.id)
              ?.path ?? repository.path,
          ...sourceRepositoryWorktreeIsolation(
            prepared,
            repository.id,
            repository.worktreeIsolation,
          ),
        };
      }
      if (isolation.requested === "source") {
        onPreparationFailure?.({
          repositoryId: repository.id,
          sourceWorktree: repository.path,
          reason: "source execution worktree could not be prepared",
        });
        return {
          id: repository.id,
          path: repository.path,
          ...sourceRepositoryWorktreeIsolation(
            workOrder,
            repository.id,
            repository.worktreeIsolation,
          ),
        };
      }
    }
    const prepared = prepareGitExecutionWorktree({
      runGit,
      sourceWorktree: repository.path,
      workOrder,
      repositoryId: repository.id,
    });
    if (prepared === null || "detail" in prepared) {
      if (looksLikeGitWorktree(repository.path)) {
        onPreparationFailure?.({
          repositoryId: repository.id,
          sourceWorktree: repository.path,
          reason: "isolated execution worktree could not be prepared",
          ...(prepared === null ? {} : { detail: prepared.detail }),
        });
      }
      return { id: repository.id, path: repository.path };
    }
    return {
      id: repository.id,
      path: prepared.executionWorktree,
      sourcePath: repository.path,
      worktreeIsolation: "isolated" as const,
    };
  });
  return withLoopWorkspaceRepositoryExecutionWorktrees(workOrder, replacements);
}

function failExecutionWorktreePreparation(
  input: {
    workOrder: LoopWorkOrder;
    onPreparationFailure?: (failure: LoopExecutionWorktreePreparationFailure) => void;
  },
  failure: LoopExecutionWorktreePreparationFailure,
): LoopWorkOrder {
  input.onPreparationFailure?.(failure);
  return input.workOrder;
}

function sourceRepositoryWorktreeIsolation(
  prepared: LoopWorkOrder,
  repositoryId: string,
  fallback?: LoopWorktreeIsolationMode,
): { worktreeIsolation?: LoopWorktreeIsolationMode } {
  const worktreeIsolation =
    prepared.workspace?.repositories.find((candidate) => candidate.id === repositoryId)
      ?.worktreeIsolation ?? fallback;
  return worktreeIsolation === undefined ? {} : { worktreeIsolation };
}

function prepareSourceExecutionWorktree(input: {
  workOrder: LoopWorkOrder;
  sourceWorktree: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  repositoryId?: string;
}): LoopWorkOrder | null {
  if (!looksLikeGitWorktree(input.sourceWorktree)) {
    log.warn("loop source execution requested for non-git target", {
      data: loggableInput(input),
    });
    return null;
  }
  const sourceTopLevel = input.runGit({
    cwd: input.sourceWorktree,
    args: ["rev-parse", "--show-toplevel"],
  });
  if (sourceTopLevel.status !== 0 || sourceTopLevel.stdout.trim().length === 0) {
    log.warn("loop source execution skipped because git toplevel could not be verified", {
      data: {
        ...loggableInput(input),
        reason: sourceTopLevel.stderr || sourceTopLevel.stdout || "git rev-parse failed",
      },
    });
    return null;
  }
  const sourceRoot = resolvePath(sourceTopLevel.stdout.trim());
  if (sourceRoot !== resolvePath(input.sourceWorktree)) {
    log.warn("loop source execution skipped because target is not git root", {
      data: { ...loggableInput(input), gitTopLevel: sourceRoot },
    });
    return null;
  }
  const syncFailure = syncSourceExecutionBranch(input, "source execution");
  if (syncFailure !== null) return null;
  const status = input.runGit({
    cwd: input.sourceWorktree,
    args: ["status", "--porcelain"],
  });
  if (status.status !== 0) {
    log.warn("loop source execution skipped because git status failed", {
      data: {
        ...loggableInput(input),
        reason: status.stderr || status.stdout || "git status failed",
      },
    });
    return null;
  }
  if (status.stdout.trim().length > 0) {
    log.warn("loop source execution skipped because source worktree is dirty", {
      data: { ...loggableInput(input), status: status.stdout.trim() },
    });
    return null;
  }
  log.info("loop using configured source execution worktree", {
    data: loggableInput(input),
  });
  if (input.repositoryId !== undefined && input.workOrder.workspace !== undefined) {
    return withLoopWorkspaceRepositoryExecutionWorktrees(input.workOrder, [
      { id: input.repositoryId, path: input.sourceWorktree, worktreeIsolation: "source" },
    ]);
  }
  return withLoopSourceWorktree(input.workOrder);
}

function prepareGitExecutionWorktree(input: {
  workOrder: LoopWorkOrder;
  sourceWorktree: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  repositoryId?: string;
}): { executionWorktree: string } | { detail: string } | null {
  if (!looksLikeGitWorktree(input.sourceWorktree)) {
    log.warn("loop skipped execution worktree isolation because target has no .git entry", {
      data: loggableInput(input),
    });
    return null;
  }
  const sourceTopLevel = input.runGit({
    cwd: input.sourceWorktree,
    args: ["rev-parse", "--show-toplevel"],
  });
  if (sourceTopLevel.status !== 0 || sourceTopLevel.stdout.trim().length === 0) {
    log.warn("loop skipped execution worktree isolation for non-git target", {
      data: {
        ...loggableInput(input),
        reason: sourceTopLevel.stderr || sourceTopLevel.stdout || "git rev-parse failed",
      },
    });
    return null;
  }
  const sourceRoot = resolvePath(sourceTopLevel.stdout.trim());
  if (sourceRoot !== resolvePath(input.sourceWorktree)) {
    log.warn("loop skipped execution worktree isolation because target is not git root", {
      data: { ...loggableInput(input), gitTopLevel: sourceRoot },
    });
    return null;
  }
  const base = prepareIsolatedExecutionBase(input);
  if ("detail" in base) return base;

  const executionWorktree = loopExecutionWorktreePath(input.workOrder, input.repositoryId);
  mkdirSync(dirname(executionWorktree), { recursive: true });
  const existingTopLevel = input.runGit({
    cwd: executionWorktree,
    args: ["rev-parse", "--show-toplevel"],
  });
  if (
    existingTopLevel.status === 0 &&
    existingTopLevel.stdout.trim().length > 0 &&
    resolvePath(existingTopLevel.stdout.trim()) === resolvePath(executionWorktree)
  ) {
    log.info("loop reusing existing isolated execution worktree", {
      data: { ...loggableInput(input), executionWorktree },
    });
    return { executionWorktree };
  }

  const added = input.runGit({
    cwd: input.sourceWorktree,
    args: ["worktree", "add", "--detach", executionWorktree, base.ref],
  });
  if (added.status !== 0) {
    log.warn("loop failed to prepare isolated execution worktree", {
      data: {
        ...loggableInput(input),
        executionWorktree,
        reason: added.stderr || added.stdout || "git worktree add failed",
      },
    });
    return { detail: added.stderr || added.stdout || "git worktree add failed" };
  }
  log.info("loop prepared isolated execution worktree", {
    data: { ...loggableInput(input), executionWorktree },
  });
  return { executionWorktree };
}

/**
 * Prepare an isolated worker from a current base ref without changing the
 * configured source checkout. In particular, never switch or pull --rebase in
 * the source worktree: another user session or WorkOrder may be using it.
 */
function prepareIsolatedExecutionBase(input: {
  workOrder: LoopWorkOrder;
  sourceWorktree: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  repositoryId?: string;
}): { ref: string } | { detail: string } {
  const cleanBefore = input.runGit({
    cwd: input.sourceWorktree,
    args: ["status", "--porcelain"],
  });
  if (cleanBefore.status !== 0 || cleanBefore.stdout.trim().length > 0) {
    return {
      detail:
        cleanBefore.status !== 0
          ? cleanBefore.stderr || cleanBefore.stdout || "git status failed"
          : `source worktree is dirty: ${cleanBefore.stdout.trim()}`,
    };
  }

  const branch = executionBaseBranch(input.workOrder, input.repositoryId);
  if (branch === undefined) return { ref: "HEAD" };

  const fetched = input.runGit({
    cwd: input.sourceWorktree,
    args: ["fetch", "origin", branch],
  });
  if (fetched.status === 0) return { ref: `origin/${branch}` };

  const reason = fetched.stderr || fetched.stdout || `git fetch origin ${branch} failed`;
  if (isRemoteTransportFailure(reason)) {
    const localBranch = input.runGit({
      cwd: input.sourceWorktree,
      args: ["rev-parse", "--verify", `refs/heads/${branch}`],
    });
    if (localBranch.status === 0 && localBranch.stdout.trim().length > 0) {
      log.warn("loop isolated execution using verified local base because remote is unavailable", {
        data: { ...loggableInput(input), branch, reason },
      });
      return { ref: branch };
    }
  }
  return { detail: reason };
}

function syncSourceExecutionBranch(
  input: {
    workOrder: LoopWorkOrder;
    sourceWorktree: string;
    runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
    repositoryId?: string;
  },
  purpose: string,
): string | null {
  const branch = executionBaseBranch(input.workOrder, input.repositoryId);
  if (branch === undefined) return null;
  const cleanBefore = input.runGit({
    cwd: input.sourceWorktree,
    args: ["status", "--porcelain"],
  });
  if (cleanBefore.status !== 0 || cleanBefore.stdout.trim().length > 0) {
    const reason =
      cleanBefore.status !== 0
        ? cleanBefore.stderr || cleanBefore.stdout || "git status failed"
        : `source worktree is dirty: ${cleanBefore.stdout.trim()}`;
    log.warn(`loop ${purpose} blocked before branch sync`, {
      data: {
        ...loggableInput(input),
        branch,
        reason,
      },
    });
    return reason;
  }
  const commands: Array<{ label: string; args: string[] }> = [
    { label: "fetch", args: ["fetch", "origin", branch] },
    { label: "switch", args: ["switch", branch] },
    { label: "pull-rebase", args: ["pull", "--rebase", "origin", branch] },
  ];
  let remoteUnavailable = false;
  for (const command of commands) {
    if (remoteUnavailable && command.label === "pull-rebase") continue;
    const result = input.runGit({ cwd: input.sourceWorktree, args: command.args });
    if (result.status !== 0) {
      const reason = result.stderr || result.stdout || `git ${command.args.join(" ")} failed`;
      if (command.label === "fetch" && isRemoteTransportFailure(reason)) {
        const localBranch = input.runGit({
          cwd: input.sourceWorktree,
          args: ["rev-parse", "--verify", `refs/heads/${branch}`],
        });
        if (localBranch.status === 0 && localBranch.stdout.trim().length > 0) {
          remoteUnavailable = true;
          log.warn("loop branch sync using verified local branch because remote is unavailable", {
            data: { ...loggableInput(input), branch, reason },
          });
          continue;
        }
      }
      log.warn(`loop ${purpose} branch sync failed`, {
        data: {
          ...loggableInput(input),
          branch,
          step: command.label,
          reason,
        },
      });
      return reason;
    }
  }
  const cleanAfter = input.runGit({
    cwd: input.sourceWorktree,
    args: ["status", "--porcelain"],
  });
  if (cleanAfter.status !== 0 || cleanAfter.stdout.trim().length > 0) {
    const reason =
      cleanAfter.status !== 0
        ? cleanAfter.stderr || cleanAfter.stdout || "git status failed"
        : `source worktree is dirty after pull --rebase: ${cleanAfter.stdout.trim()}`;
    log.warn(`loop ${purpose} blocked after branch sync`, {
      data: {
        ...loggableInput(input),
        branch,
        reason,
      },
    });
    return reason;
  }
  log.info(`loop ${purpose} source branch synced`, {
    data: { ...loggableInput(input), branch },
  });
  return null;
}

function isRemoteTransportFailure(reason: string): boolean {
  return /connection closed|could not read from remote|could not resolve host|network is unreachable|timed out|connection reset|temporary failure/i.test(
    reason,
  );
}

function executionBaseBranch(workOrder: LoopWorkOrder, repositoryId?: string): string | undefined {
  if (workOrder.workspace !== undefined && repositoryId !== undefined) {
    const repository = workOrder.workspace.repositories.find(
      (candidate) => candidate.id === repositoryId,
    );
    return repository?.pullRequest.switchBack ?? repository?.pullRequest.base;
  }
  return workOrder.pullRequestPolicy?.switchBack ?? workOrder.pullRequestPolicy?.base;
}

type ResolvedWorktreeIsolationMode = {
  mode: Exclude<LoopWorktreeIsolationMode, "auto">;
  requested: LoopWorktreeIsolationMode;
};

function resolveWorktreeIsolationMode(
  workOrder: LoopWorkOrder,
  defaultMode: LoopWorktreeIsolationMode = "isolated",
): ResolvedWorktreeIsolationMode {
  const requested = workOrder.executionIsolation?.worktreeIsolation ?? "auto";
  return {
    requested,
    mode: resolveAutoWorktreeIsolationMode(
      requested === "auto" ? defaultMode : requested,
      workOrder,
    ),
  };
}

function resolveRepositoryWorktreeIsolationMode(
  workOrder: LoopWorkOrder,
  repository: NonNullable<LoopWorkOrder["workspace"]>["repositories"][number],
  defaultMode: LoopWorktreeIsolationMode = "isolated",
): ResolvedWorktreeIsolationMode {
  const requested =
    repository.worktreeIsolation ?? workOrder.executionIsolation?.worktreeIsolation ?? "auto";
  return {
    requested,
    mode: resolveAutoWorktreeIsolationMode(
      requested === "auto" ? defaultMode : requested,
      workOrder,
    ),
  };
}

function resolveAutoWorktreeIsolationMode(
  requested: LoopWorktreeIsolationMode,
  workOrder: LoopWorkOrder,
): Exclude<LoopWorktreeIsolationMode, "auto"> {
  if (requested !== "auto") return requested;
  return workOrder.task?.kind === "opportunity-discovery" ? "source" : "isolated";
}

function looksLikeGitWorktree(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function loopExecutionWorktreePath(workOrder: LoopWorkOrder, repositoryId?: string): string {
  return join(
    appStateDir(),
    "loop-worktrees",
    safeStatePathSegment(workOrder.projectId),
    safeStatePathSegment(workOrder.id),
    ...(repositoryId === undefined ? [] : [safeStatePathSegment(repositoryId)]),
  );
}

function safeStatePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment.length > 0 ? segment.slice(0, 120) : "workorder";
}

function loggableInput(input: {
  workOrder: LoopWorkOrder;
  sourceWorktree: string;
  repositoryId?: string;
}): Record<string, unknown> {
  return {
    runId: input.workOrder.id,
    projectId: input.workOrder.projectId,
    sourceWorktree: input.sourceWorktree,
    ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
  };
}
