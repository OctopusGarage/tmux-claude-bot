import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import {
  type LoopWorkOrder,
  withLoopExecutionWorktree,
  withLoopWorkspaceRepositoryExecutionWorktrees,
} from "./work-order.js";

const log = createLogger("loop.execution-worktree");

export function prepareLoopExecutionWorktrees(input: {
  workOrder: LoopWorkOrder;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): LoopWorkOrder {
  if (input.runGit === undefined) return input.workOrder;
  if (input.workOrder.workspace !== undefined) {
    return prepareWorkspaceExecutionWorktrees(input.workOrder, input.runGit);
  }
  const prepared = prepareGitExecutionWorktree({
    runGit: input.runGit,
    sourceWorktree: input.workOrder.projectPath,
    workOrder: input.workOrder,
  });
  return prepared === null
    ? input.workOrder
    : withLoopExecutionWorktree(input.workOrder, prepared.executionWorktree);
}

function prepareWorkspaceExecutionWorktrees(
  workOrder: LoopWorkOrder,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): LoopWorkOrder {
  const workspace = workOrder.workspace;
  if (workspace === undefined) return workOrder;
  const replacements = workspace.repositories.map((repository) => {
    const prepared = prepareGitExecutionWorktree({
      runGit,
      sourceWorktree: repository.path,
      workOrder,
      repositoryId: repository.id,
    });
    return prepared === null
      ? { id: repository.id, path: repository.path }
      : { id: repository.id, path: prepared.executionWorktree, sourcePath: repository.path };
  });
  return withLoopWorkspaceRepositoryExecutionWorktrees(workOrder, replacements);
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
