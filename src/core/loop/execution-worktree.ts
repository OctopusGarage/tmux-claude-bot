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
  return prepared === null
    ? looksLikeGitWorktree(input.workOrder.projectPath)
      ? failExecutionWorktreePreparation(input, {
          repositoryId: input.workOrder.projectId,
          sourceWorktree: input.workOrder.projectPath,
          reason: "isolated execution worktree could not be prepared",
        })
      : input.workOrder
    : withLoopExecutionWorktree(input.workOrder, prepared.executionWorktree);
}

export type LoopExecutionWorktreePreparationFailure = {
  repositoryId: string;
  sourceWorktree: string;
  reason: string;
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
    if (prepared === null) {
      if (looksLikeGitWorktree(repository.path)) {
        onPreparationFailure?.({
          repositoryId: repository.id,
          sourceWorktree: repository.path,
          reason: "isolated execution worktree could not be prepared",
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
  if (!syncSourceExecutionBranch(input, "source execution")) return null;
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
}): { executionWorktree: string } | null {
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
  if (!syncSourceExecutionBranch(input, "isolated execution")) return null;

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
    args: ["worktree", "add", "--detach", executionWorktree, "HEAD"],
  });
  if (added.status !== 0) {
    log.warn("loop failed to prepare isolated execution worktree", {
      data: {
        ...loggableInput(input),
        executionWorktree,
        reason: added.stderr || added.stdout || "git worktree add failed",
      },
    });
    return null;
  }
  log.info("loop prepared isolated execution worktree", {
    data: { ...loggableInput(input), executionWorktree },
  });
  return { executionWorktree };
}

function syncSourceExecutionBranch(
  input: {
    workOrder: LoopWorkOrder;
    sourceWorktree: string;
    runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
    repositoryId?: string;
  },
  purpose: string,
): boolean {
  const branch = executionBaseBranch(input.workOrder, input.repositoryId);
  if (branch === undefined) return true;
  const cleanBefore = input.runGit({
    cwd: input.sourceWorktree,
    args: ["status", "--porcelain"],
  });
  if (cleanBefore.status !== 0 || cleanBefore.stdout.trim().length > 0) {
    log.warn(`loop ${purpose} blocked before branch sync`, {
      data: {
        ...loggableInput(input),
        branch,
        reason:
          cleanBefore.status !== 0
            ? cleanBefore.stderr || cleanBefore.stdout || "git status failed"
            : `source worktree is dirty: ${cleanBefore.stdout.trim()}`,
      },
    });
    return false;
  }
  const commands: Array<{ label: string; args: string[] }> = [
    { label: "fetch", args: ["fetch", "origin", branch] },
    { label: "switch", args: ["switch", branch] },
    { label: "pull-rebase", args: ["pull", "--rebase", "origin", branch] },
  ];
  for (const command of commands) {
    const result = input.runGit({ cwd: input.sourceWorktree, args: command.args });
    if (result.status !== 0) {
      log.warn(`loop ${purpose} branch sync failed`, {
        data: {
          ...loggableInput(input),
          branch,
          step: command.label,
          reason: result.stderr || result.stdout || `git ${command.args.join(" ")} failed`,
        },
      });
      return false;
    }
  }
  const cleanAfter = input.runGit({
    cwd: input.sourceWorktree,
    args: ["status", "--porcelain"],
  });
  if (cleanAfter.status !== 0 || cleanAfter.stdout.trim().length > 0) {
    log.warn(`loop ${purpose} blocked after branch sync`, {
      data: {
        ...loggableInput(input),
        branch,
        reason:
          cleanAfter.status !== 0
            ? cleanAfter.stderr || cleanAfter.stdout || "git status failed"
            : `source worktree is dirty after pull --rebase: ${cleanAfter.stdout.trim()}`,
      },
    });
    return false;
  }
  log.info(`loop ${purpose} source branch synced`, {
    data: { ...loggableInput(input), branch },
  });
  return true;
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
