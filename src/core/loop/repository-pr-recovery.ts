import type { RepositoryPullRequestRecoveryEvidenceWriter } from "./repository-pr-recovery-store.js";
import type {
  LoopSupervisorFinalSummary,
  LoopSupervisorPullRequestDecision,
  LoopSupervisorPullRequestHumanBoundary,
} from "./work-order-contract.js";

export type RepositoryPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export type RepositoryPullRequestWorkflowRun = {
  id: number;
  headSha: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "pending" | "unknown";
  conclusion: string | null;
};

export type PrivateForkWorkflowPolicy = {
  runWorkflowsFromForkPullRequests: boolean;
  sendWriteTokensToWorkflows: boolean;
  sendSecretsAndVariables: boolean;
  requireApprovalForForkPrWorkflows: boolean;
};

export const SAFE_PRIVATE_FORK_WORKFLOW_POLICY: PrivateForkWorkflowPolicy = {
  runWorkflowsFromForkPullRequests: true,
  sendWriteTokensToWorkflows: false,
  sendSecretsAndVariables: false,
  requireApprovalForForkPrWorkflows: false,
};

export type RepositoryPullRequestObservation = {
  repository: string;
  number: number;
  state: "open" | "closed" | "merged";
  headSha: string;
  headRepository: string;
  baseRepository: string;
  isDraft: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  mergeStateStatus: string;
  repositoryPrivate: boolean;
  actor: string;
  actorPermission: RepositoryPermission;
  workflowRuns: RepositoryPullRequestWorkflowRun[];
  forkWorkflowPolicy?: PrivateForkWorkflowPolicy;
};

export type RepositoryPullRequestRecoveryAction =
  | { kind: "approve-workflow"; runId: number }
  | { kind: "rerun-workflow"; runId: number }
  | { kind: "configure-private-fork-workflows"; policy: PrivateForkWorkflowPolicy }
  | { kind: "mark-ready" };

export type RepositoryPullRequestRecoveryPlan =
  | { kind: "none"; reason: string }
  | { kind: "retry"; reason: string }
  | {
      kind: "manual-review";
      boundary: LoopSupervisorPullRequestHumanBoundary;
      reason: string;
    }
  | { kind: "repair"; reason: string; actions: RepositoryPullRequestRecoveryAction[] };

const MUTATION_PERMISSIONS = new Set<RepositoryPermission>(["write", "maintain", "admin"]);
type RepositoryPullRequestReviewDecision = Pick<
  LoopSupervisorPullRequestDecision,
  "outcome" | "reviewedHeadSha"
>;

export function isSafePrivateForkWorkflowPolicy(policy: PrivateForkWorkflowPolicy): boolean {
  return (
    policy.runWorkflowsFromForkPullRequests &&
    !policy.sendWriteTokensToWorkflows &&
    !policy.sendSecretsAndVariables &&
    !policy.requireApprovalForForkPrWorkflows
  );
}

/** Pure classification. All mutations are performed by the account-bound adapter. */
export function planRepositoryPullRequestRecovery(
  observation: RepositoryPullRequestObservation,
  decision?: RepositoryPullRequestReviewDecision,
): RepositoryPullRequestRecoveryPlan {
  if (observation.state === "merged") {
    return { kind: "none", reason: "pull request is already merged" };
  }
  if (observation.state === "closed") {
    return { kind: "none", reason: "pull request is already closed" };
  }
  if (!MUTATION_PERMISSIONS.has(observation.actorPermission)) {
    return {
      kind: "manual-review",
      boundary: "ownership",
      reason: "configured GitHub actor lacks repository mutation authority",
    };
  }

  const headRuns = observation.workflowRuns.filter((run) => run.headSha === observation.headSha);
  const actionRequired = headRuns.find((run) => run.conclusion === "action_required");
  if (actionRequired !== undefined) {
    if (observation.repositoryPrivate) {
      if (observation.forkWorkflowPolicy === undefined) {
        return { kind: "retry", reason: "private fork workflow policy could not be observed" };
      }
      const actions: RepositoryPullRequestRecoveryAction[] = [];
      if (!isSafePrivateForkWorkflowPolicy(observation.forkWorkflowPolicy)) {
        actions.push({
          kind: "configure-private-fork-workflows",
          policy: SAFE_PRIVATE_FORK_WORKFLOW_POLICY,
        });
      }
      actions.push({ kind: "rerun-workflow", runId: actionRequired.id });
      return {
        kind: "repair",
        reason:
          actions[0]?.kind === "configure-private-fork-workflows"
            ? "private fork workflows are disabled for an action-required head run"
            : "action-required head workflow can be rerun under the safe private-fork policy",
        actions,
      };
    }
    return {
      kind: "repair",
      reason: "public fork workflow awaits supported approval",
      actions: [{ kind: "approve-workflow", runId: actionRequired.id }],
    };
  }

  if (headRuns.some((run) => run.status !== "completed")) {
    return { kind: "retry", reason: "head workflow checks are pending" };
  }
  if (observation.mergeable === "conflicting" || observation.mergeStateStatus === "dirty") {
    return { kind: "retry", reason: "same-repository conflict remains repairable" };
  }
  if (observation.mergeable === "unknown") {
    return { kind: "retry", reason: "GitHub mergeability is transiently unknown" };
  }
  if (observation.isDraft) {
    if (decision?.outcome !== "approved") {
      return { kind: "retry", reason: "pull request draft requires approved review evidence" };
    }
    if (decision.reviewedHeadSha !== observation.headSha) {
      return { kind: "retry", reason: "approved review does not match the current reviewed head" };
    }
    if (headRuns.length === 0) {
      return { kind: "retry", reason: "head workflow checks are unavailable" };
    }
    if (headRuns.some((run) => !isSuccessfulWorkflowConclusion(run.conclusion))) {
      return { kind: "retry", reason: "head workflow checks are not passing" };
    }
    return {
      kind: "repair",
      reason: "reviewed draft pull request is ready for review",
      actions: [{ kind: "mark-ready" }],
    };
  }
  return { kind: "none", reason: "no deterministic repository recovery action is required" };
}

export type RepositoryPullRequestRecoveryController = {
  recover(
    summary: LoopSupervisorFinalSummary,
    input: { account: string; cwd: string; now: number },
  ): {
    disposition: "completed" | "retry" | "manual-review";
    openPullRequests: number;
    repaired: number;
  };
};

export type RepositoryPullRequestRecoveryGitHub = {
  observe(input: {
    repository: string;
    number: number;
    account: string;
  }): RepositoryPullRequestObservation;
  execute(
    target: { repository: string; number: number; headSha: string },
    action: RepositoryPullRequestRecoveryAction,
    account: string,
  ): { ok: true } | { ok: false; reason: string };
};

export function createRepositoryPullRequestRecoveryController(input: {
  github: RepositoryPullRequestRecoveryGitHub;
  evidence: RepositoryPullRequestRecoveryEvidenceWriter;
  verifyTarget?: (cwd: string) => boolean;
}): RepositoryPullRequestRecoveryController {
  return {
    recover: (summary, context) => {
      if (input.verifyTarget !== undefined && !input.verifyTarget(context.cwd)) {
        throw new Error("configured project path is not its exact git top-level");
      }
      const decisions = summary.pullRequestDecisions ?? [];
      let repaired = 0;
      let retry = false;
      let manual = false;
      let openPullRequests = 0;
      for (const decision of decisions) {
        if (decision.outcome === "merged" || decision.outcome === "closed") continue;
        openPullRequests += 1;
        if (decision.outcome === "manual-review" && decision.boundary !== undefined) {
          manual = true;
          continue;
        }
        const observed = input.github.observe({
          repository: decision.repository,
          number: decision.number,
          account: context.account,
        });
        const plan = planRepositoryPullRequestRecovery(observed, decision);
        if (plan.kind === "manual-review") {
          manual = true;
          continue;
        }
        if (plan.kind === "none") {
          if (observed.state === "open") retry = true;
          else openPullRequests -= 1;
          continue;
        }
        retry = true;
        if (plan.kind !== "repair") continue;
        for (const action of plan.actions) {
          const fresh = input.github.observe({
            repository: decision.repository,
            number: decision.number,
            account: context.account,
          });
          const freshPlan = planRepositoryPullRequestRecovery(fresh, decision);
          if (
            fresh.state !== "open" ||
            fresh.headSha !== observed.headSha ||
            freshPlan.kind !== "repair" ||
            !freshPlan.actions.some((candidate) => sameRecoveryAction(candidate, action))
          ) {
            continue;
          }
          if (input.verifyTarget !== undefined && !input.verifyTarget(context.cwd)) {
            throw new Error("configured project path is not its exact git top-level");
          }
          const evidenceTarget = {
            repository: decision.repository,
            number: decision.number,
            headSha: fresh.headSha,
            action: action.kind,
            ...("runId" in action ? { runId: action.runId } : {}),
          };
          const previous = input.evidence.lookup?.(evidenceTarget);
          if (
            previous === "intent" ||
            (previous === "succeeded" && action.kind !== "configure-private-fork-workflows")
          ) {
            continue;
          }
          let intent: { id: string };
          try {
            intent = input.evidence.begin({
              ...evidenceTarget,
              now: context.now,
            });
          } catch (error) {
            throw new Error("repository PR recovery intent persistence failed", { cause: error });
          }
          const outcome = input.github.execute(
            {
              repository: decision.repository,
              number: decision.number,
              headSha: fresh.headSha,
            },
            action,
            context.account,
          );
          input.evidence.finish(intent.id, {
            status: outcome.ok ? "succeeded" : "failed",
            reason: outcome.ok ? `${action.kind} completed` : outcome.reason,
            now: context.now,
          });
          if (outcome.ok) repaired += 1;
        }
      }
      return {
        disposition: retry ? "retry" : manual ? "manual-review" : "completed",
        openPullRequests,
        repaired,
      };
    },
  };
}

function sameRecoveryAction(
  left: RepositoryPullRequestRecoveryAction,
  right: RepositoryPullRequestRecoveryAction,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "configure-private-fork-workflows") {
    return (
      right.kind === "configure-private-fork-workflows" &&
      JSON.stringify(left.policy) === JSON.stringify(right.policy)
    );
  }
  if (left.kind === "mark-ready") return right.kind === "mark-ready";
  return (
    (right.kind === "approve-workflow" || right.kind === "rerun-workflow") &&
    left.runId === right.runId
  );
}

function isSuccessfulWorkflowConclusion(conclusion: string | null): boolean {
  return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";
}
