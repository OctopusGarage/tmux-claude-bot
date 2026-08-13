export type LoopRemoteBranchCloseReason = "duplicate" | "obsolete" | "non-actionable" | "invalid";

export type LoopRemoteBranchTarget = {
  repository: string;
  projectId: string;
  account: string;
  baseBranches: string[];
};

export type LoopRemoteBranchPullRequest = {
  number: number;
  state: "open" | "merged" | "closed";
  headBranch: string;
  headSha: string;
  baseBranch: string;
  closedAt?: string;
  externalCloseReason?: LoopRemoteBranchCloseReason;
};

export type LoopRemoteBranchObservation = {
  repository: string;
  branch: string;
  sha: string;
  protected: boolean;
  defaultBranch: string;
  pullRequests: LoopRemoteBranchPullRequest[];
};

export type LoopRemoteBranchGitHub = {
  discover(
    target: LoopRemoteBranchTarget,
    limit: number,
  ): Promise<{ defaultBranch: string; branches: Array<{ branch: string }> }>;
  observe(
    target: LoopRemoteBranchTarget,
    branch: string,
  ): Promise<LoopRemoteBranchObservation | null>;
  delete(
    target: LoopRemoteBranchTarget,
    branch: string,
    expectedSha: string,
  ): Promise<{ ok: boolean; alreadyAbsent: boolean; reason?: string }>;
};

export type LoopRemoteBranchEvidenceStatus = "intent" | "succeeded" | "failed";

type LoopRemoteBranchEvidenceTarget = {
  repository: string;
  branch: string;
  sha: string;
  pullRequestNumber?: number;
};

export type LoopRemoteBranchEvidenceWriter = {
  begin(
    input: LoopRemoteBranchEvidenceTarget & {
      reason: string;
      now: number;
    },
  ): { id: string };
  finish(
    id: string,
    input: {
      status: Exclude<LoopRemoteBranchEvidenceStatus, "intent">;
      reason: string;
      now: number;
    },
  ): void;
  lookup(input: LoopRemoteBranchEvidenceTarget): LoopRemoteBranchEvidenceStatus | undefined;
};

type CleanupPlan =
  | { kind: "delete"; pullRequestNumber?: number; reason: string }
  | { kind: "skip"; reason: string };

export function planLoopRemoteBranchCleanup(input: {
  target: LoopRemoteBranchTarget;
  observation: LoopRemoteBranchObservation;
  liveBranches: ReadonlySet<string>;
  terminalBranches?: ReadonlySet<string>;
  closedReasons: ReadonlyMap<string, LoopRemoteBranchCloseReason>;
}): CleanupPlan {
  const { target, observation } = input;
  if (observation.repository !== target.repository) {
    return { kind: "skip", reason: "repository-mismatch" };
  }
  if (
    observation.branch === observation.defaultBranch ||
    target.baseBranches.includes(observation.branch)
  ) {
    return { kind: "skip", reason: "protected-base-branch" };
  }
  if (observation.protected) return { kind: "skip", reason: "protected-branch" };
  const prefix = `loop/${target.projectId}/`;
  if (!observation.branch.startsWith(prefix)) {
    return { kind: "skip", reason: "outside-configured-prefix" };
  }
  if (input.liveBranches.has(observation.branch)) {
    return { kind: "skip", reason: "live-work-order-owner" };
  }

  const exactPullRequests = observation.pullRequests.filter(
    (pullRequest) => pullRequest.headBranch === observation.branch,
  );
  if (exactPullRequests.some((pullRequest) => pullRequest.state === "open")) {
    return { kind: "skip", reason: "open-pull-request" };
  }
  if (exactPullRequests.length === 0) {
    return input.terminalBranches?.has(observation.branch) === true
      ? { kind: "delete", reason: "terminal-work-order-without-pull-request" }
      : { kind: "skip", reason: "pull-request-missing" };
  }

  const matching = exactPullRequests.filter(
    (pullRequest) => pullRequest.headSha === observation.sha,
  );
  if (matching.length === 0) return { kind: "skip", reason: "pull-request-head-mismatch" };
  const merged = matching.find((pullRequest) => pullRequest.state === "merged");
  if (merged !== undefined) {
    return { kind: "delete", pullRequestNumber: merged.number, reason: "merged-pull-request" };
  }

  const closed = matching.find((pullRequest) => pullRequest.state === "closed");
  if (closed === undefined) return { kind: "skip", reason: "terminal-pull-request-missing" };
  const closeReason =
    input.closedReasons.get(`${target.repository}#${closed.number}`) ?? closed.externalCloseReason;
  if (closeReason === undefined) return { kind: "skip", reason: "closed-reason-missing" };
  return {
    kind: "delete",
    pullRequestNumber: closed.number,
    reason: `closed-${closeReason}`,
  };
}

export type LoopRemoteBranchReconciliationSummary = {
  scanned: number;
  eligible: number;
  deleted: number;
  skipped: number;
  failed: number;
};

export function createLoopRemoteBranchReconciler(input: {
  github: LoopRemoteBranchGitHub;
  evidence: LoopRemoteBranchEvidenceWriter;
}): {
  reconcile(options: {
    targets: readonly LoopRemoteBranchTarget[];
    liveBranches: ReadonlySet<string>;
    terminalBranches?: ReadonlySet<string>;
    closedReasons: ReadonlyMap<string, LoopRemoteBranchCloseReason>;
    now: number;
    limitPerRepository?: number;
  }): Promise<LoopRemoteBranchReconciliationSummary>;
} {
  return {
    reconcile: async (options) => {
      const summary: LoopRemoteBranchReconciliationSummary = {
        scanned: 0,
        eligible: 0,
        deleted: 0,
        skipped: 0,
        failed: 0,
      };
      const limit = options.limitPerRepository ?? 100;
      const terminalBranches = options.terminalBranches ?? new Set<string>();
      for (const target of options.targets) {
        let branches: Array<{ branch: string }>;
        try {
          ({ branches } = await input.github.discover(target, limit));
        } catch {
          summary.failed += 1;
          continue;
        }
        for (const { branch } of branches) {
          summary.scanned += 1;
          let evidenceId: string | undefined;
          try {
            const initial = await input.github.observe(target, branch);
            if (initial === null) {
              summary.skipped += 1;
              continue;
            }
            const plan = planLoopRemoteBranchCleanup({
              target,
              observation: initial,
              liveBranches: options.liveBranches,
              terminalBranches,
              closedReasons: options.closedReasons,
            });
            if (plan.kind === "skip") {
              summary.skipped += 1;
              continue;
            }
            summary.eligible += 1;
            const evidenceTarget = {
              repository: target.repository,
              branch,
              sha: initial.sha,
              ...(plan.pullRequestNumber === undefined
                ? {}
                : { pullRequestNumber: plan.pullRequestNumber }),
            };
            if (input.evidence.lookup(evidenceTarget) === "succeeded") {
              summary.skipped += 1;
              continue;
            }
            const intent = input.evidence.begin({
              ...evidenceTarget,
              reason: plan.reason,
              now: options.now,
            });
            evidenceId = intent.id;
            const current = await input.github.observe(target, branch);
            if (current === null) {
              input.evidence.finish(intent.id, {
                status: "succeeded",
                reason: "branch was already absent during revalidation",
                now: options.now,
              });
              summary.skipped += 1;
              continue;
            }
            const currentPlan = planLoopRemoteBranchCleanup({
              target,
              observation: current,
              liveBranches: options.liveBranches,
              terminalBranches,
              closedReasons: options.closedReasons,
            });
            if (
              current.sha !== initial.sha ||
              currentPlan.kind !== "delete" ||
              currentPlan.pullRequestNumber !== plan.pullRequestNumber
            ) {
              input.evidence.finish(intent.id, {
                status: "failed",
                reason: "branch facts changed during deletion revalidation",
                now: options.now,
              });
              summary.failed += 1;
              continue;
            }
            const deletion = await input.github.delete(target, branch, initial.sha);
            if (!deletion.ok) {
              input.evidence.finish(intent.id, {
                status: "failed",
                reason: deletion.reason ?? "GitHub branch deletion failed",
                now: options.now,
              });
              summary.failed += 1;
              continue;
            }
            input.evidence.finish(intent.id, {
              status: "succeeded",
              reason: deletion.alreadyAbsent
                ? "branch was already absent"
                : "remote branch deleted",
              now: options.now,
            });
            if (deletion.alreadyAbsent) summary.skipped += 1;
            else summary.deleted += 1;
          } catch (error) {
            if (evidenceId !== undefined) {
              try {
                input.evidence.finish(evidenceId, {
                  status: "failed",
                  reason: safeReconciliationError(error),
                  now: options.now,
                });
              } catch {
                // The primary failure remains authoritative when evidence settlement also fails.
              }
            }
            summary.failed += 1;
          }
        }
      }
      return summary;
    },
  };
}

function safeReconciliationError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/https:\/\/[^/@\s]+@/gi, "https://<redacted>@")
    .slice(0, 500);
}
