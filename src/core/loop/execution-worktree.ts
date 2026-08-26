import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
        repairDisposition: "bot-repairable",
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
          repairDisposition: "bot-repairable",
        })
      : input.workOrder;
  }
  if ("detail" in prepared) {
    return failExecutionWorktreePreparation(input, {
      repositoryId: input.workOrder.projectId,
      sourceWorktree: input.workOrder.projectPath,
      reason: "isolated execution worktree could not be prepared",
      detail: prepared.detail,
      repairDisposition: prepared.detail.startsWith("source worktree is dirty:")
        ? "target-or-external-blocker"
        : "bot-repairable",
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
type LoopExecutionWorktreeCleanupInput = {
  worktree: string;
  sourceWorktree?: string;
  expectedBranch?: string;
};

type MissingWorktreeRegistrations = Map<string, Set<string> | null>;
type LoopExecutionWorktreeCleanupResult = "removed" | "already-clean" | "failed";

// Derived optimization only: a restart revalidates Git, and a recreated path
// clears its entry before any cleanup decision.
const reconciledMissingWorktrees = new Set<string>();

function missingWorktreeReconciliationKey(input: {
  worktree: string;
  expectedBranch?: string | undefined;
}): string {
  return input.expectedBranch === undefined
    ? input.worktree
    : `${input.worktree}\0${input.expectedBranch}`;
}

function clearMissingWorktreeReconciliations(worktree: string): void {
  for (const key of reconciledMissingWorktrees) {
    if (key === worktree || key.startsWith(`${worktree}\0`)) {
      reconciledMissingWorktrees.delete(key);
    }
  }
}

/** Reuse one verified worktree registry snapshot across a reconciliation pass. */
export function createLoopExecutionWorktreeCleanup(
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): (input: LoopExecutionWorktreeCleanupInput) => LoopExecutionWorktreeCleanupResult {
  const registrations = new Map<string, Set<string> | null>();
  return (input) => cleanupLoopExecutionWorktreeWithRegistrations(input, runGit, registrations);
}

export function cleanupLoopExecutionWorktree(
  input: LoopExecutionWorktreeCleanupInput & {
    runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  },
): boolean {
  return (
    cleanupLoopExecutionWorktreeWithRegistrations(
      input,
      input.runGit,
      new Map<string, Set<string> | null>(),
    ) !== "failed"
  );
}

function cleanupLoopExecutionWorktreeWithRegistrations(
  input: LoopExecutionWorktreeCleanupInput,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
  registrations: MissingWorktreeRegistrations,
): LoopExecutionWorktreeCleanupResult {
  const worktree = resolvePath(input.worktree);
  const reconciliationKey = missingWorktreeReconciliationKey({
    worktree,
    expectedBranch: input.expectedBranch,
  });
  if (!isBotOwnedLoopExecutionWorktree(worktree)) {
    log.warn("loop refused to remove worktree outside bot-owned state", {
      data: { worktree },
    });
    return "failed";
  }
  if (input.expectedBranch !== undefined && !isBotOwnedLoopBranch(input.expectedBranch)) {
    log.warn("loop refused to remove an unexpected local branch", {
      data: { worktree, branch: input.expectedBranch },
    });
    return "failed";
  }
  if (!existsSync(worktree)) {
    if (reconciledMissingWorktrees.has(reconciliationKey)) {
      return "already-clean";
    }
    if (input.sourceWorktree === undefined) {
      log.warn("loop cannot reconcile missing worktree without its source repository", {
        data: { worktree },
      });
      return "failed";
    }
    const sourceWorktree = resolvePath(input.sourceWorktree);
    const registered = readMissingWorktreeRegistrations({
      worktree,
      sourceWorktree,
      runGit,
      registrations,
    });
    if (registered === null) return "failed";
    if (!registered.has(worktree)) {
      if (input.expectedBranch !== undefined) {
        if (
          !cleanupExactLocalLoopBranch({
            sourceWorktree,
            branch: input.expectedBranch,
            runGit,
          })
        ) {
          return "failed";
        }
      }
      reconciledMissingWorktrees.add(reconciliationKey);
      log.debug("loop missing worktree registration is already reconciled", {
        data: { worktree, sourceWorktree },
      });
      return "already-clean";
    }
    const removed = runGit({
      cwd: sourceWorktree,
      args: ["worktree", "remove", "--force", worktree],
    });
    if (removed.status !== 0) {
      log.warn("loop failed to remove missing worktree registration", {
        data: {
          worktree,
          sourceWorktree,
          reason: removed.stderr || removed.stdout || "git worktree remove failed",
        },
      });
      return "failed";
    }
    registered.delete(worktree);
    if (
      input.expectedBranch !== undefined &&
      !cleanupExactLocalLoopBranch({
        sourceWorktree,
        branch: input.expectedBranch,
        runGit,
      })
    ) {
      return "failed";
    }
    reconciledMissingWorktrees.add(reconciliationKey);
    log.info("loop removed missing worktree registration", {
      data: { worktree, sourceWorktree },
    });
    return "removed";
  }
  clearMissingWorktreeReconciliations(worktree);
  let branchHead: string | undefined;
  if (input.expectedBranch !== undefined) {
    if (input.sourceWorktree === undefined) {
      log.warn("loop cannot remove a local branch without its source repository", {
        data: { worktree, branch: input.expectedBranch },
      });
      return "failed";
    }
    const sourceTopLevel = verifiedSourceTopLevel(input.sourceWorktree, runGit);
    if (
      sourceTopLevel.status !== 0 ||
      resolvePath(sourceTopLevel.stdout.trim()) !== resolvePath(input.sourceWorktree)
    ) {
      log.warn("loop refused local branch cleanup from an unverified source repository", {
        data: { worktree, sourceWorktree: input.sourceWorktree },
      });
      return "failed";
    }
  }
  const topLevel = runGit({ cwd: worktree, args: ["rev-parse", "--show-toplevel"] });
  if (topLevel.status !== 0 || resolvePath(topLevel.stdout.trim()) !== worktree) {
    log.warn("loop refused to remove path that is not the expected git worktree", {
      data: {
        worktree,
        reason: topLevel.stderr || topLevel.stdout || "git toplevel verification failed",
      },
    });
    return "failed";
  }
  if (input.expectedBranch !== undefined) {
    const currentBranch = runGit({ cwd: worktree, args: ["branch", "--show-current"] });
    const currentBranchName = currentBranch.stdout.trim();
    if (
      currentBranch.status !== 0 ||
      (currentBranchName !== "" && currentBranchName !== input.expectedBranch)
    ) {
      log.warn("loop refused to remove a worktree on an unexpected branch", {
        data: {
          worktree,
          expectedBranch: input.expectedBranch,
          actualBranch: currentBranchName,
        },
      });
      return "failed";
    }
    const head = runGit({ cwd: worktree, args: ["rev-parse", "--verify", "HEAD"] });
    if (head.status !== 0 || !isGitObjectId(head.stdout.trim())) {
      log.warn("loop refused to remove a worktree whose HEAD could not be verified", {
        data: { worktree, branch: input.expectedBranch },
      });
      return "failed";
    }
    branchHead = head.stdout.trim();
    if (currentBranchName === input.expectedBranch) {
      const detached = runGit({ cwd: worktree, args: ["switch", "--detach", branchHead] });
      if (detached.status !== 0) {
        log.warn("loop failed to detach a terminal worktree before local branch cleanup", {
          data: { worktree, branch: input.expectedBranch },
        });
        return "failed";
      }
    }
    if (
      input.sourceWorktree !== undefined &&
      !cleanupExactLocalLoopBranch({
        sourceWorktree: resolvePath(input.sourceWorktree),
        branch: input.expectedBranch,
        expectedSha: branchHead,
        runGit,
      })
    ) {
      return "failed";
    }
  }
  const removed = runGit({
    cwd: worktree,
    args: ["worktree", "remove", "--force", worktree],
  });
  if (removed.status !== 0) {
    if (
      removeStandaloneBotCheckoutAfterMainWorktreeFailure({
        worktree,
        reason: removed.stderr || removed.stdout,
        runGit,
      })
    ) {
      reconciledMissingWorktrees.add(reconciliationKey);
      log.info("loop removed standalone bot-owned checkout", { data: { worktree } });
      return "removed";
    }
    log.warn("loop failed to remove expired isolated worktree", {
      data: {
        worktree,
        reason: removed.stderr || removed.stdout || "git worktree remove failed",
      },
    });
    return "failed";
  }
  reconciledMissingWorktrees.add(reconciliationKey);
  log.info("loop removed expired isolated worktree", { data: { worktree } });
  return "removed";
}

function removeStandaloneBotCheckoutAfterMainWorktreeFailure(input: {
  worktree: string;
  reason: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): boolean {
  if (!input.reason.includes("is a main working tree")) return false;
  if (!statSync(join(input.worktree, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
    return false;
  }
  const branch = input.runGit({ cwd: input.worktree, args: ["branch", "--show-current"] });
  if (branch.status !== 0 || branch.stdout.trim() !== "") return false;
  const status = input.runGit({ cwd: input.worktree, args: ["status", "--porcelain"] });
  if (status.status !== 0 || status.stdout.trim() !== "") return false;
  try {
    rmSync(input.worktree, { recursive: true, force: true });
    return !existsSync(input.worktree);
  } catch (err) {
    log.warn("loop failed to remove standalone bot-owned checkout", {
      err,
      data: { worktree: input.worktree },
    });
    return false;
  }
}

function cleanupExactLocalLoopBranch(input: {
  sourceWorktree: string;
  branch: string;
  expectedSha?: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): boolean {
  const listed = input.runGit({
    cwd: input.sourceWorktree,
    args: ["worktree", "list", "--porcelain"],
  });
  if (listed.status !== 0) return false;
  if (listed.stdout.split(/\r?\n/).includes(`branch refs/heads/${input.branch}`)) {
    log.warn("loop refused to remove a local branch still owned by a worktree", {
      data: { sourceWorktree: input.sourceWorktree, branch: input.branch },
    });
    return false;
  }
  const ref = `refs/heads/${input.branch}`;
  const observed = input.runGit({
    cwd: input.sourceWorktree,
    args: ["show-ref", "--verify", "--hash", ref],
  });
  if (observed.status !== 0) return observed.status === 1 && observed.stdout.trim() === "";
  const observedSha = observed.stdout.trim();
  if (!isGitObjectId(observedSha)) return false;
  if (input.expectedSha !== undefined && observedSha !== input.expectedSha) {
    log.warn("loop refused to remove a local branch whose SHA changed", {
      data: { sourceWorktree: input.sourceWorktree, branch: input.branch },
    });
    return false;
  }
  const deleted = input.runGit({
    cwd: input.sourceWorktree,
    args: ["update-ref", "-d", ref, observedSha],
  });
  return deleted.status === 0;
}

function isBotOwnedLoopBranch(branch: string): boolean {
  return (
    branch.startsWith("loop/") &&
    !branch.startsWith("loop//") &&
    !branch.endsWith("/") &&
    !branch.includes("..") &&
    !/[~^:?*[\\\s]/.test(branch)
  );
}

function isGitObjectId(value: string): boolean {
  return /^[a-fA-F0-9]{40,64}$/.test(value);
}

function readMissingWorktreeRegistrations(input: {
  worktree: string;
  sourceWorktree: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  registrations: MissingWorktreeRegistrations;
}): Set<string> | null {
  if (input.registrations.has(input.sourceWorktree)) {
    return input.registrations.get(input.sourceWorktree) ?? null;
  }
  const sourceTopLevel = verifiedSourceTopLevel(input.sourceWorktree, input.runGit);
  if (
    sourceTopLevel.status !== 0 ||
    sourceTopLevel.stdout.trim().length === 0 ||
    resolvePath(sourceTopLevel.stdout.trim()) !== input.sourceWorktree
  ) {
    log.warn("loop refused to reconcile missing worktree from an unverified source repository", {
      data: {
        worktree: input.worktree,
        sourceWorktree: input.sourceWorktree,
        reason:
          sourceTopLevel.stderr ||
          sourceTopLevel.stdout ||
          "source git toplevel verification failed",
      },
    });
    input.registrations.set(input.sourceWorktree, null);
    return null;
  }
  const listed = input.runGit({
    cwd: input.sourceWorktree,
    args: ["worktree", "list", "--porcelain"],
  });
  if (listed.status !== 0) {
    log.warn("loop failed to inspect missing worktree registration", {
      data: {
        worktree: input.worktree,
        sourceWorktree: input.sourceWorktree,
        reason: listed.stderr || listed.stdout || "git worktree list failed",
      },
    });
    input.registrations.set(input.sourceWorktree, null);
    return null;
  }
  const registered = new Set(
    listed.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolvePath(line.slice("worktree ".length))),
  );
  input.registrations.set(input.sourceWorktree, registered);
  return registered;
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
  repairDisposition: "bot-repairable" | "target-or-external-blocker";
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
          repairDisposition: "bot-repairable",
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
          repairDisposition: prepared?.detail.startsWith("source worktree is dirty:")
            ? "target-or-external-blocker"
            : "bot-repairable",
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
  const sourceTopLevel = verifiedSourceTopLevel(input.sourceWorktree, input.runGit);
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
  const sourceTopLevel = verifiedSourceTopLevel(input.sourceWorktree, input.runGit);
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
    const branchFailure = prepareIsolatedExecutionBranch(input, executionWorktree, base.ref);
    if (branchFailure !== null) return { detail: branchFailure };
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
  const branchFailure = prepareIsolatedExecutionBranch(input, executionWorktree, base.ref);
  if (branchFailure !== null) return { detail: branchFailure };
  log.info("loop prepared isolated execution worktree", {
    data: { ...loggableInput(input), executionWorktree },
  });
  return { executionWorktree };
}

/**
 * Recover the one safe Git-config corruption possible for a normal checkout:
 * a directory with its own `.git/` was accidentally marked bare. A genuine bare
 * repository has no nested `.git/`, so this repair cannot convert one into a
 * worktree. Every other toplevel failure remains fail-closed.
 */
function verifiedSourceTopLevel(
  sourceWorktree: string,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): LoopRunCommandResult {
  const first = runGit({ cwd: sourceWorktree, args: ["rev-parse", "--show-toplevel"] });
  const gitDir = join(sourceWorktree, ".git");
  if (first.status === 0 || !statSync(gitDir, { throwIfNoEntry: false })?.isDirectory())
    return first;

  const configuredBare = runGit({
    cwd: sourceWorktree,
    args: ["--git-dir", gitDir, "config", "--bool", "--get", "core.bare"],
  });
  if (configuredBare.status !== 0 || configuredBare.stdout.trim() !== "true") return first;
  const repaired = runGit({
    cwd: sourceWorktree,
    args: ["--git-dir", gitDir, "config", "core.bare", "false"],
  });
  if (repaired.status !== 0) return first;
  log.warn("loop repaired normal source checkout marked as bare", {
    data: { sourceWorktree },
  });
  return runGit({ cwd: sourceWorktree, args: ["rev-parse", "--show-toplevel"] });
}

function prepareIsolatedExecutionBranch(
  input: {
    workOrder: LoopWorkOrder;
    runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  },
  executionWorktree: string,
  baseRef: string,
  resetBranch = true,
): string | null {
  const branch = input.workOrder.commitPolicy.branch;
  if (branch === undefined) return null;
  const args = resetBranch ? ["switch", "-C", branch, baseRef] : ["switch", branch];
  const switched = input.runGit({
    cwd: executionWorktree,
    args,
  });
  if (switched.status === 0) return null;
  return switched.stderr || switched.stdout || `git ${args.join(" ")} failed`;
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
