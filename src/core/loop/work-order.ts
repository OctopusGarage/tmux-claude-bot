import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import type { ApprovedSkill } from "../skills/schema.js";
import type {
  LoopConfig,
  LoopProjectConfig,
  LoopRepositoryPullRequestReviewConfig,
  LoopWorkspaceConfig,
} from "./config.js";

export type SupervisorFinalStatus = "completed" | "failed" | "blocked" | "timeout" | "cancelled";

export type LoopSupervisorFinalSummary = {
  status: SupervisorFinalStatus;
  projectId: string;
  actionsTaken: string[];
  delegatedTasks: Array<{ projectId: string; status: SupervisorFinalStatus } | string>;
  finalVerification: "passed" | "failed" | "not-run" | "unknown";
  commits: string[];
  followUps: string[];
};

export type LoopWorkOrder = {
  id: string;
  scheduledAt: number;
  task?:
    | { kind: "architecture" }
    | {
        kind: "workspace-architecture";
        prompt?: string;
      }
    | {
        kind: "bug-fix";
        maxRounds: number;
        maxBugsPerRound: number;
        requireRegressionTest: boolean;
        prompt?: string;
      }
    | {
        kind: "test-coverage";
        targetCoverage: number;
        maxRounds: number;
        requireMeaningfulTests: boolean;
        allowIntegrationTests: boolean;
        allowSmokeTests: boolean;
        allowE2ETests: boolean;
        allowAiEvalTests: boolean;
        prompt?: string;
      }
    | {
        kind: "pull-request-review";
        lookbackHours: number;
        consecutivePasses: number;
        autoMerge: boolean;
        prompt?: string;
      }
    | {
        kind: "repository-pull-request-review";
        repo: string;
        base?: string;
        lookbackHours: number;
        consecutivePasses: number;
        autoMerge: boolean;
        repair: {
          enabled: boolean;
          maxAttempts: number;
          prompt?: string;
        };
        prompt?: string;
      };
  projectId: string;
  projectName: string;
  projectPath: string;
  agent: LoopProjectConfig["agent"];
  goal: string;
  maxRounds: number;
  targetScore: number;
  runner: LoopProjectConfig["runner"];
  allowedActions: string[];
  blockedActions: string[];
  skills: { approved: ApprovedSkill[] };
  preflight: LoopProjectConfig["preflight"];
  assessment: LoopProjectConfig["assessment"];
  eval?: LoopProjectConfig["eval"];
  execution: LoopProjectConfig["execution"];
  recovery: LoopProjectConfig["recovery"];
  commitPolicy: LoopProjectConfig["commit"];
  pullRequestPolicy?: LoopProjectConfig["pullRequest"];
  workspace?: {
    root: string;
    repositories: Array<{
      id: string;
      name: string;
      path: string;
      role: string;
      agent: LoopProjectConfig["agent"];
      pullRequest: LoopProjectConfig["pullRequest"];
    }>;
  };
  requiredFinalMarker: string;
  finalSummaryPath?: string;
};

type ParseSupervisorFinalSummaryResult =
  | { ok: true; summary: LoopSupervisorFinalSummary }
  | { ok: false; reason: "missing-final-marker" | "invalid-summary" };

const SUPERVISOR_FINAL_STATUSES = new Set<SupervisorFinalStatus>([
  "completed",
  "failed",
  "blocked",
  "timeout",
  "cancelled",
]);
const SUPERVISOR_FINAL_STATUS_LIST = '"completed", "blocked", "failed", "timeout", "cancelled"';

const FINAL_VERIFICATION_STATUSES = new Set<LoopSupervisorFinalSummary["finalVerification"]>([
  "passed",
  "failed",
  "not-run",
  "unknown",
]);

export function finalMarkerForWorkOrder(workOrderId: string): string {
  return `[LOOP_SUPERVISOR_DONE:${workOrderId}]`;
}

export function buildLoopWorkOrder(input: {
  config: LoopConfig;
  project: LoopProjectConfig;
  scheduledAt: number;
  runId: string;
  jobKind?: "architecture" | "bug-fix" | "test-coverage" | "pull-request-review";
}): LoopWorkOrder {
  const task =
    input.jobKind === "pull-request-review"
      ? pullRequestReviewTask(input.project.pullRequestReview)
      : input.jobKind === "test-coverage"
        ? testCoverageTask(input.project.testCoverage)
        : input.jobKind === "bug-fix"
          ? bugFixTask(input.project.bugFix)
          : { kind: "architecture" as const };
  const workOrder: LoopWorkOrder = {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    task,
    projectId: input.project.id,
    projectName: input.project.name,
    projectPath: input.project.path,
    agent: input.project.agent,
    goal: input.project.goal,
    maxRounds:
      task.kind === "bug-fix" || task.kind === "test-coverage"
        ? task.maxRounds
        : input.project.maxRounds,
    targetScore: input.project.targetScore,
    runner: input.project.runner,
    allowedActions: [...input.project.allowedActions],
    blockedActions: [...input.project.blockedActions],
    skills: { approved: [...input.config.skills.approved] },
    preflight: input.project.preflight,
    assessment: input.project.assessment,
    execution: input.project.execution,
    recovery: input.project.recovery,
    commitPolicy: commitPolicyForWorkOrder(commitPolicyForTask(input.project, task), input.runId),
    pullRequestPolicy: input.project.pullRequest,
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
    finalSummaryPath: finalSummaryPathForWorkOrder(input.project.id, input.runId),
  };

  if (input.project.eval !== undefined) {
    workOrder.eval = input.project.eval;
  }

  return workOrder;
}

export function buildRepositoryPullRequestReviewWorkOrder(input: {
  config: LoopConfig;
  repository: LoopRepositoryPullRequestReviewConfig;
  scheduledAt: number;
  runId: string;
}): LoopWorkOrder {
  const repository = input.repository;
  return {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    task: repositoryPullRequestReviewTask(repository),
    projectId: repository.id,
    projectName: repository.name,
    projectPath: repository.path,
    agent: repository.agent,
    goal: `Review and merge eligible pull requests for ${repository.repo}.`,
    maxRounds: 1,
    targetScore: 100,
    runner: repository.runner,
    allowedActions: ["tests", "docs", "small-refactor"],
    blockedActions: ["direct-model-api", "broad-rewrite"],
    skills: { approved: [...input.config.skills.approved] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "true" },
    execution: { agent: true },
    recovery: { agent: true, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: false },
    pullRequestPolicy: {
      enabled: true,
      base: repository.base ?? repository.switchBack,
      switchBack: repository.switchBack,
      autoMerge: repository.autoMerge,
      ...(repository.githubAccount !== undefined
        ? { githubAccount: repository.githubAccount }
        : {}),
    },
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
    finalSummaryPath: finalSummaryPathForWorkOrder(repository.id, input.runId),
  };
}

export function buildWorkspaceArchitectureWorkOrder(input: {
  config: LoopConfig;
  workspace: LoopWorkspaceConfig;
  scheduledAt: number;
  runId: string;
}): LoopWorkOrder {
  const workspace = input.workspace;
  return {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    task: {
      kind: "workspace-architecture",
      ...(workspace.architecture.prompt !== undefined
        ? { prompt: workspace.architecture.prompt }
        : {}),
    },
    projectId: workspace.id,
    projectName: workspace.name,
    projectPath: workspace.root,
    agent: workspace.agent,
    goal: workspace.architecture.goal,
    maxRounds: workspace.architecture.maxRounds,
    targetScore: workspace.architecture.targetScore,
    runner: workspace.architecture.runner,
    allowedActions: [...workspace.allowedActions],
    blockedActions: [...workspace.blockedActions],
    skills: { approved: [...input.config.skills.approved] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "true" },
    execution: { agent: true },
    recovery: { agent: true, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: false },
    pullRequestPolicy: { enabled: false, base: "main", switchBack: "main", autoMerge: false },
    workspace: {
      root: workspace.root,
      repositories: workspace.repositories.map((repository) => ({
        id: repository.id,
        name: repository.name,
        path: repository.path,
        role: repository.role,
        agent: repository.agent ?? workspace.agent,
        pullRequest: repository.pullRequest,
      })),
    },
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
    finalSummaryPath: finalSummaryPathForWorkOrder(workspace.id, input.runId),
  };
}

export function buildLoopSupervisorPrompt(workOrder: LoopWorkOrder): string {
  const cli = loopControlCliCommand();
  const baseBranch = baseBranchForWorkOrder(workOrder);
  const finalSummaryPath = finalSummaryPathForWorkOrder(workOrder.projectId, workOrder.id);
  const ghIdentityPolicy = githubIdentityPolicy(workOrder);
  const task = workOrderTask(workOrder);
  const taskPolicy =
    task.kind === "pull-request-review"
      ? pullRequestReviewPolicy(workOrder, baseBranch)
      : task.kind === "repository-pull-request-review"
        ? repositoryPullRequestReviewPolicy(workOrder, baseBranch)
        : task.kind === "workspace-architecture"
          ? workspaceArchitecturePolicy(workOrder)
          : task.kind === "test-coverage"
            ? testCoveragePolicy(workOrder)
            : task.kind === "bug-fix"
              ? bugFixPolicy(workOrder)
              : architecturePolicy(workOrder);
  return [
    "You are the Loop Supervisor for tmux-claude-bot.",
    "",
    "WorkOrder JSON:",
    JSON.stringify(workOrder, null, 2),
    "",
    "Policy:",
    "- Execute only this bounded work order.",
    ...taskPolicy,
    "- Use the currently running Claude Code / Codex agent capability only.",
    "- Do not call model-provider APIs.",
    "- Do not add model SDKs, model API keys, or direct model HTTP integrations.",
    "- Respect allowedActions and blockedActions exactly.",
    "- Preserve unrelated user work and avoid broad rewrites.",
    syncPolicy(workOrder, baseBranch),
    "- If the base sync fails, the worktree is dirty, or fast-forward is impossible, stop and report blocked; do not optimize stale code.",
    commitBranchPolicy(workOrder),
    ghIdentityPolicy,
    ...agentSessionPolicy(workOrder, cli),
    "",
    "Available control commands:",
    `- ${cli} dashboard --json`,
    `- ${cli} sessions`,
    `- ${cli} open <project> --agent <claude|codex>`,
    `- ${cli} peek <project>`,
    `- ${cli} control <project> compact --yes`,
    `- ${cli} send <project> "<task>"`,
    `- ${cli} loop run <config> <projectId>`,
    `- ${cli} notify ...`,
    "",
    "Required final response:",
    `- Write the strict JSON final summary to ${shellQuote(finalSummaryPath)} before printing the final marker.`,
    "- The JSON file must contain fields: status, projectId, actionsTaken, delegatedTasks, finalVerification, commits, followUps. delegatedTasks must be an array of strings, or objects with only projectId and status.",
    `- status must be exactly one of: ${SUPERVISOR_FINAL_STATUS_LIST}. Use "completed" for successful no-op runs; do not use "passed", "complete", "done", or "success" as status.`,
    `- Then print ${workOrder.requiredFinalMarker} on its own line. You may print the same strict JSON after it, but the file is authoritative.`,
    '- finalVerification must be one string only: "passed", "failed", "not-run", or "unknown"; put detailed verification notes in actionsTaken or followUps, not in finalVerification.',
    "- commits must contain only real commit hashes or strings that start with a real commit hash; put PR URLs, PR numbers, and status notes in actionsTaken or followUps.",
    "- Before finalizing a PR task, bug-fix task, test-coverage task, or architecture task that opened a PR, re-read the PR body and remove known generated review/release-note blocks such as CodeRabbit auto-generated summaries; the PR body must contain only the intended human-authored summary, verification, and notes.",
  ].join("\n");
}

function bugFixTask(
  policy: LoopProjectConfig["bugFix"],
): Extract<LoopWorkOrder["task"], { kind: "bug-fix" }> {
  return {
    kind: "bug-fix",
    maxRounds: policy.maxRounds,
    maxBugsPerRound: policy.maxBugsPerRound,
    requireRegressionTest: policy.requireRegressionTest,
    ...(policy.prompt !== undefined ? { prompt: policy.prompt } : {}),
  };
}

function testCoverageTask(
  policy: LoopProjectConfig["testCoverage"],
): Extract<LoopWorkOrder["task"], { kind: "test-coverage" }> {
  return {
    kind: "test-coverage",
    targetCoverage: policy.targetCoverage,
    maxRounds: policy.maxRounds,
    requireMeaningfulTests: policy.requireMeaningfulTests,
    allowIntegrationTests: policy.allowIntegrationTests,
    allowSmokeTests: policy.allowSmokeTests,
    allowE2ETests: policy.allowE2ETests,
    allowAiEvalTests: policy.allowAiEvalTests,
    ...(policy.prompt !== undefined ? { prompt: policy.prompt } : {}),
  };
}

function pullRequestReviewTask(
  policy: LoopProjectConfig["pullRequestReview"],
): Extract<LoopWorkOrder["task"], { kind: "pull-request-review" }> {
  return {
    kind: "pull-request-review",
    lookbackHours: policy.lookbackHours,
    consecutivePasses: policy.consecutivePasses,
    autoMerge: policy.autoMerge,
    ...(policy.prompt !== undefined ? { prompt: policy.prompt } : {}),
  };
}

function repositoryPullRequestReviewTask(
  policy: LoopRepositoryPullRequestReviewConfig,
): Extract<LoopWorkOrder["task"], { kind: "repository-pull-request-review" }> {
  return {
    kind: "repository-pull-request-review",
    repo: policy.repo,
    ...(policy.base !== undefined ? { base: policy.base } : {}),
    lookbackHours: policy.lookbackHours,
    consecutivePasses: policy.consecutivePasses,
    autoMerge: policy.autoMerge,
    repair: {
      enabled: policy.repair.enabled,
      maxAttempts: policy.repair.maxAttempts,
      ...(policy.repair.prompt !== undefined ? { prompt: policy.repair.prompt } : {}),
    },
    ...(policy.prompt !== undefined ? { prompt: policy.prompt } : {}),
  };
}

function workOrderTask(workOrder: LoopWorkOrder): NonNullable<LoopWorkOrder["task"]> {
  return workOrder.task ?? { kind: "architecture" };
}

function syncPolicy(workOrder: LoopWorkOrder, baseBranch: string): string {
  if (workOrder.workspace !== undefined) {
    return [
      "- Before assessment or delegated work, sync every workspace repository:",
      ...workOrder.workspace.repositories.map(
        (repository) =>
          `  - cd ${shellQuote(repository.path)} && git status --short must be clean, then git fetch origin ${repository.pullRequest.switchBack}, git switch ${repository.pullRequest.switchBack}, and git pull --ff-only origin ${repository.pullRequest.switchBack}.`,
      ),
    ].join("\n");
  }
  return `- Before assessment or delegated work, sync the target base branch: cd ${shellQuote(workOrder.projectPath)} && git status --short must be clean, then git fetch origin ${baseBranch}, git switch ${baseBranch}, and git pull --ff-only origin ${baseBranch}.`;
}

function architecturePolicy(workOrder: LoopWorkOrder): string[] {
  return [
    "- Work in focused rounds and stop at the configured limits.",
    `- Architecture target score is ${workOrder.targetScore}; if evaluation reaches or exceeds it, stop instead of optimizing for its own sake.`,
  ];
}

function workspaceArchitecturePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "workspace-architecture" || workOrder.workspace === undefined) return [];
  return [
    "Workspace architecture task.",
    `- Treat ${workOrder.projectName} as one bounded workspace with ${workOrder.workspace.repositories.length} repositories.`,
    `- Architecture target score is ${workOrder.targetScore}; if the cross-repository evaluation reaches or exceeds it, stop instead of optimizing for its own sake.`,
    "- First inspect the contracts between repositories: API routes, schemas, generated clients, shared DTOs, auth/session assumptions, build/deploy coupling, error handling, and data/state ownership.",
    "- Prefer the smallest set of repository changes that improves the whole workspace. Do not force every repository to change.",
    "- If a change crosses repository boundaries, update all affected repositories in the same round and verify the contract from both sides.",
    "- Each repository keeps its own git branch and pull request. Use one shared run id, link the related PRs in every PR body, and describe the cross-repository reason clearly.",
    ...workOrder.workspace.repositories.map(
      (repository) =>
        `- For ${repository.id}, use branch loop/${repository.id}/architecture/${workOrder.id}, open the PR against ${repository.pullRequest.base}, switch back to ${repository.pullRequest.switchBack}, and ${workspaceGithubPolicy(repository)}.`,
    ),
    "- Before finalizing, verify every changed repository is on its configured switch-back branch, clean, and has a human-readable PR body without generated review/release-note blocks.",
    task.prompt !== undefined ? `- Additional workspace instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function workspaceGithubPolicy(
  repository: NonNullable<LoopWorkOrder["workspace"]>["repositories"][number],
): string {
  const account = repository.pullRequest.githubAccount;
  if (account === undefined) return "use the repository's normal GitHub CLI identity";
  return `use command-local GitHub authentication via export GH_TOKEN="$(gh auth token --user ${shellQuote(account)})" before gh pr commands; do not rely on the global gh active account`;
}

function bugFixPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "bug-fix") return [];
  return [
    "Bug finding and repair task.",
    `- Run at most ${task.maxRounds} focused bug-fix round(s); each round may fix at most ${task.maxBugsPerRound} confirmed bug(s).`,
    "- Search for real bugs only: functional correctness, reliability, data/state consistency, missed or duplicate execution, wrong success/failure reporting, unsafe merge behavior, unhandled edge cases, security-sensitive mistakes, or user-visible regressions.",
    "- Audit through concrete risk lenses: money, quota, billing, permissions, privilege escalation, concurrency, transactions, data correctness, idempotency, scheduling/state machines, error-handling contracts, and cross-module or frontend/backend contracts.",
    "- Do not nitpick style, naming, wording, formatting, harmless refactors, architecture taste, or speculative concerns.",
    "- Do not add product features, new capabilities, new dependencies, broad rewrites, or unrelated cleanup.",
    "- Before editing, prove the issue is real by recording the trigger path, affected behavior, and why it is not merely a preference or theoretical concern.",
    "- If the impact depends on another boundary layer, such as a caller, callee, API, worker, scheduler, database constraint, or frontend/backend pair, inspect that boundary before confirming the bug.",
    "- Before editing, perform an independent verification pass from the current final code state and calling path; if that pass cannot reconstruct the bug mechanism, skip the candidate.",
    "- If a suspected issue cannot be proven as a real functional or reliability risk, record it as skipped and do not edit for it.",
    "- Keep each repair small, local, and consistent with existing project patterns.",
    task.requireRegressionTest
      ? "- Add or update a focused regression test for every code bug you fix. If a regression test is genuinely impossible, record the reason and use the narrowest available verification instead."
      : "- Prefer focused regression tests for fixed bugs, but follow the configured project verification contract when tests are impractical.",
    "- After each repair, independently re-check that the original trigger path is blocked and that the diff did not add feature work, unrelated refactors, or a new functional risk; then run the relevant checks.",
    "- Stop when a round finds no confirmed real bugs; do not continue looking just because maxRounds remains.",
    task.prompt !== undefined ? `- Additional bug-fix instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function testCoveragePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "test-coverage") return [];
  return [
    "Test coverage improvement task.",
    `- Target effective test coverage is at least ${task.targetCoverage}%. Stop when the project reaches that threshold and the important risk paths have meaningful tests.`,
    `- Run at most ${task.maxRounds} focused test-improvement round(s). Each round must start by inspecting the current test stack, coverage command/report, uncovered behavior, and highest-risk production paths.`,
    "- Add tests only when they assert real behavior or guard a plausible regression. Do not add import-only tests, empty assertions, mock implementation tests, snapshot padding, fixture churn, or tests whose only value is increasing a metric.",
    "- Prefer focused unit tests for deterministic domain logic and edge cases. Add integration, smoke, E2E, or AI eval tests only when the project shape and risk justify them.",
    task.allowIntegrationTests
      ? "- Integration tests are allowed when they verify real module, API, persistence, queue, scheduler, or frontend/backend boundaries that unit tests cannot cover well."
      : "- Do not add integration tests for this task.",
    task.allowSmokeTests
      ? "- Smoke tests are allowed when they cheaply prove the app, CLI, worker, or service starts and the critical happy path is wired."
      : "- Do not add smoke tests for this task.",
    task.allowE2ETests
      ? "- E2E tests are allowed only for critical user-visible workflows whose risk cannot be covered reliably at lower levels."
      : "- Do not add E2E tests for this task.",
    task.allowAiEvalTests
      ? "- AI eval tests are allowed only when the project already has an agent-backed or deterministic eval surface; do not add direct model-provider API calls, model SDKs, or model API keys."
      : "- Do not add AI eval tests for this task.",
    task.requireMeaningfulTests
      ? "- Every added or changed test must have a clear behavior/risk statement in actionsTaken. If you cannot state the behavior it protects, do not keep the test."
      : "- Prefer meaningful behavior tests and record any metric-only exception explicitly.",
    "- If coverage is blocked because code is over-coupled or hard to exercise, make the smallest necessary refactor that improves testability without changing behavior, then test the extracted behavior.",
    "- If you discover a real bug, vulnerability, flaky behavior, broken test harness, or incorrect existing test while adding coverage, independently confirm it, fix it narrowly, and add a regression test when practical.",
    "- After each round, run the relevant test/coverage command and inspect the diff to confirm it did not add features, broad rewrites, brittle tests, or meaningless coverage.",
    "- If the project has no reliable unified coverage command, report that clearly, add the highest-value tests for critical paths, and use the narrowest available verification instead of inventing a fake coverage number.",
    task.prompt !== undefined ? `- Additional test-coverage instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function pullRequestReviewPolicy(workOrder: LoopWorkOrder, baseBranch: string): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "pull-request-review") return [];
  return [
    "Pull request review and merge task.",
    `- Review open loop-created PRs for this repository targeting ${baseBranch}, prioritizing PRs created or updated within the last ${task.lookbackHours} hours.`,
    "- Treat loop-created PRs as PRs whose head branch starts with loop/ or whose title/body clearly identifies Loop Engineering.",
    `- Run two independent review passes for each candidate PR. Merge only when ${task.consecutivePasses} consecutive passes find no bug, CI, mergeability, data loss, security, migration, or user-visible regression risk.`,
    "- Do not nitpick style, naming, wording, or harmless refactors. Focus on whether the PR introduced a real bug or operational risk.",
    "- Inspect the PR diff, files changed, commits, mergeability, and CI/status checks before deciding.",
    "- If checks are pending, inconclusive, failing, or mergeability is unknown/conflicting, do not merge; record the exact blocker.",
    task.autoMerge
      ? "- If both review passes pass and CI/status checks are successful, merge the PR with GitHub CLI, then sync the local switch-back branch."
      : "- Do not merge automatically; report the review decision only.",
    task.prompt !== undefined ? `- Additional review instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function repositoryPullRequestReviewPolicy(
  workOrder: LoopWorkOrder,
  _baseBranch: string,
): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "repository-pull-request-review") return [];
  const scope = task.base === undefined ? "all base branches" : `base branch ${task.base}`;
  const listCommand =
    task.base === undefined
      ? `gh pr list --repo ${task.repo} --state open --limit 100 --json number,title,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,updatedAt,url,labels`
      : `gh pr list --repo ${task.repo} --state open --base ${task.base} --limit 100 --json number,title,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,updatedAt,url,labels`;
  return [
    "Repository pull request review and merge task.",
    `- Review every open pull request in ${task.repo} for ${scope}.`,
    `- At the start and immediately before final summary, list open PRs with: ${listCommand}.`,
    "- In actionsTaken, record the open PR count and each in-scope PR number/base/head/decision. If any PR is out of scope, record the explicit reason.",
    `- Prioritize PRs created or updated within the last ${task.lookbackHours} hours, but do not ignore older open PRs unless they are drafts, blocked, or explicitly marked do-not-merge.`,
    `- Run two independent review passes for each candidate PR. Merge only when ${task.consecutivePasses} consecutive passes find no bug, CI, mergeability, data loss, security, migration, dependency, deployment, or user-visible regression risk.`,
    "- Do not nitpick style, naming, wording, formatting, or harmless refactors. Focus on whether the PR introduced a real bug or operational risk.",
    "- Inspect each PR diff, files changed, commits, review comments, mergeability, and CI/status checks before deciding.",
    "- If checks are pending, inconclusive, failing, required reviews are missing, the PR is a draft, mergeability is unknown/conflicting, or the branch is behind in a way GitHub cannot update safely, do not merge; record the exact blocker.",
    "- When polling after a repair push or merge attempt, always request PR state and mergedAt in addition to mergeability and checks. If GitHub reports state=MERGED, stop waiting on mergeability, verify checks and local switch-back state, then write the final summary.",
    ...repositoryPullRequestRepairPolicy(task),
    task.autoMerge
      ? "- If both review passes pass and CI/status checks are successful, merge the PR with GitHub CLI, then sync the local switch-back branch."
      : "- Do not merge automatically; report the review decision only.",
    task.autoMerge
      ? '- Final status must be "completed" only when every in-scope open PR was merged or explicitly skipped for a non-actionable reason such as draft, do-not-merge, external fork without permission, or required review. If any in-scope PR remains open because of a fixable blocker, conflict, failed/pending check, or unattempted repair, final status must be "blocked" or "failed", not "completed".'
      : '- Final status may be "completed" only after every in-scope open PR has a recorded review decision.',
    task.prompt !== undefined ? `- Additional review instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function repositoryPullRequestRepairPolicy(
  task: Extract<LoopWorkOrder["task"], { kind: "repository-pull-request-review" }>,
): string[] {
  if (!task.repair.enabled || task.repair.maxAttempts === 0) {
    return ["- Do not modify PR branches; report blockers only."];
  }
  return [
    `- If a PR has only small, low-risk, clearly fixable issues, you may make at most ${task.repair.maxAttempts} repair attempt(s) on the PR's original head branch, then push that same branch and re-check the PR before considering merge.`,
    "- Repair is allowed only for same-repository branches that this GitHub account can push to. Do not modify external fork PRs.",
    "- Before repairing, inspect the PR head ref and confirm the branch is not protected, not a draft, not marked do-not-merge, and safe to push.",
    "- If a same-repository PR is conflicting, repair only when the conflict is small and deterministic, such as dependency manifest/lockfile drift that can be regenerated with the repository's normal package manager. Otherwise record the conflict as a blocker.",
    "- If the only blocker is that a same-repository PR branch is behind the base branch, first prefer GitHub's safe branch update/rebase mechanism (for example gh pr update-branch when available); otherwise update the existing PR head branch with the base branch without creating a new PR branch, then rerun checks and both review passes.",
    "- Keep repairs limited to the introduced issue: formatting, type/lint/test failures, obvious missing import/export, straightforward dependency lock update, small test expectation correction, or a similarly bounded bug fix.",
    "- Do not repair issues that need product judgment, schema/data migration judgment, security design judgment, broad refactoring, public API redesign, or large dependency upgrades; record them as blockers.",
    "- To repair: fetch the PR head branch, switch to it, pull fast-forward, apply the minimal fix, run the relevant failing checks plus the repository's normal local verification when available, review the diff, commit with a clear message, push to the PR head branch, then re-read PR status/checks/mergeability.",
    "- After a repair push, do not merge until CI/status checks have completed successfully and the review passes are repeated on the updated PR.",
    task.repair.prompt !== undefined
      ? `- Additional repair instruction: ${task.repair.prompt}`
      : "",
  ].filter(Boolean);
}

function agentSessionPolicy(workOrder: LoopWorkOrder, cli: string): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind === "workspace-architecture" && workOrder.workspace !== undefined) {
    return [
      "- This workspace task may delegate to multiple real project sessions; do not create a synthetic workspace product session.",
      ...workOrder.workspace.repositories.flatMap((repository) => [
        `- Open ${repository.name} with the configured agent: ${cli} open ${repository.id} --agent ${repository.agent}.`,
        `- After opening ${repository.id}, verify ${cli} dashboard --json shows that real project running with the configured agent.`,
      ]),
      `- Run ${cli} control <project> compact --yes before each delegated optimization round for every repository you ask to work.`,
    ];
  }
  if (task.kind === "repository-pull-request-review") {
    return [
      "- This repository-wide PR review runs directly from projectPath in this supervisor task; do not call tcb open for the synthetic *-all-prs id.",
      `- Use shell commands from ${shellQuote(workOrder.projectPath)} plus GitHub CLI to inspect, repair, push, and merge PRs.`,
      "- If you need to delegate code editing to a project session, open the real repository path manually; do not require that as a gate for PR review.",
    ];
  }
  return [
    `- Open the target project with the configured agent: ${cli} open ${workOrder.projectId} --agent ${workOrder.agent}.`,
    `- After opening, verify ${cli} dashboard --json shows the target project running with the configured agent; if it does not, stop and report blocked.`,
    contextResetPolicy(workOrder, cli),
  ];
}

function commitBranchPolicy(workOrder: LoopWorkOrder): string {
  const task = workOrderTask(workOrder);
  if (task.kind === "pull-request-review") {
    return "- This review task must not create a new PR branch or commit code changes.";
  }
  if (task.kind === "repository-pull-request-review") {
    if (!task.repair.enabled || task.repair.maxAttempts === 0) {
      return "- This review task must not create a new PR branch or commit code changes.";
    }
    return "- This review task must not create a new PR branch; bounded repair may commit only on an eligible PR's existing same-repository head branch.";
  }
  return workOrder.commitPolicy.branch
    ? `- Use the WorkOrder commitPolicy.branch exactly: ${workOrder.commitPolicy.branch}. Do not reuse or merge any other loop branch.`
    : "- If commits are disabled or no commit branch is configured, do not create a PR branch.";
}

function contextResetPolicy(workOrder: LoopWorkOrder, cli: string): string {
  const task = workOrderTask(workOrder);
  if (task.kind === "pull-request-review") {
    return `- Run ${cli} control <project> compact --yes before each delegated review pass.`;
  }
  if (task.kind === "bug-fix") {
    return `- Run ${cli} control <project> compact --yes before each delegated bug-fix round.`;
  }
  if (task.kind === "test-coverage") {
    return `- Run ${cli} control <project> compact --yes before each delegated test-coverage round.`;
  }
  if (task.kind === "repository-pull-request-review") {
    return `- Run ${cli} control <project> compact --yes before each delegated repository PR review pass.`;
  }
  return `- Run ${cli} control <project> compact --yes before each delegated optimization round.`;
}

function githubIdentityPolicy(workOrder: LoopWorkOrder): string {
  const account = workOrder.pullRequestPolicy?.githubAccount;
  if (!workOrder.pullRequestPolicy?.enabled || account === undefined) {
    return "- For GitHub CLI commands, use the repository's normal gh context.";
  }
  const tokenCommand = `GH_TOKEN="$(gh auth token --user ${shellQuote(account)})"`;
  return `- For every GitHub CLI PR command, use the configured account with a command-local token: ${tokenCommand} gh pr <create|view|merge> ...; do not rely on the global gh active account.`;
}

function commitPolicyForWorkOrder(
  policy: LoopProjectConfig["commit"],
  runId: string,
): LoopProjectConfig["commit"] {
  if (!policy.enabled || policy.branch === undefined) return policy;
  return {
    ...policy,
    branch: `${policy.branch.replace(/\/+$/g, "")}/${sanitizeBranchSegment(runId)}`,
  };
}

function commitPolicyForTask(
  project: LoopProjectConfig,
  task: NonNullable<LoopWorkOrder["task"]>,
): LoopProjectConfig["commit"] {
  if (task.kind === "bug-fix" && project.bugFix.branch !== undefined) {
    return {
      ...project.commit,
      branch: project.bugFix.branch,
    };
  }
  if (task.kind === "test-coverage" && project.testCoverage.branch !== undefined) {
    return {
      ...project.commit,
      branch: project.testCoverage.branch,
    };
  }
  return project.commit;
}

function sanitizeBranchSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function finalSummaryPathForWorkOrder(projectId: string, runId: string): string {
  return join(appStateDir(), "loop-runs", projectId, runId, "supervisor-final-summary.json");
}

function baseBranchForWorkOrder(workOrder: LoopWorkOrder): string {
  return workOrder.pullRequestPolicy?.switchBack ?? workOrder.pullRequestPolicy?.base ?? "main";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function loopControlCliCommand(): string {
  const cwd = process.cwd();
  const tsxBin = join(cwd, "node_modules", ".bin", "tsx");
  const sourceCli = join(cwd, "src", "cli.ts");
  return existsSync(tsxBin) && existsSync(sourceCli)
    ? `${shellQuote(tsxBin)} ${shellQuote(sourceCli)}`
    : "tcb";
}

export function buildLoopSupervisorFinalizationPrompt(
  workOrder: LoopWorkOrder,
  previousOutput: string,
): string {
  const finalSummaryPath = finalSummaryPathForWorkOrder(workOrder.projectId, workOrder.id);
  return [
    "You are still the Loop Supervisor for tmux-claude-bot.",
    "",
    "The previous response for this WorkOrder did not include a parseable final summary, so the",
    "system could not run its final gates.",
    "",
    "WorkOrder JSON:",
    JSON.stringify(workOrder, null, 2),
    "",
    "Previous output tail:",
    previousOutput.slice(-4000),
    "",
    "Required action now:",
    "- Inspect the target project/session state as needed.",
    "- If the delegated target is still working, wait or poll until it reaches a safe handoff.",
    "- If work is complete, verify the final project state, commit/push/open PR as required by the WorkOrder.",
    "- If you cannot safely complete, report blocked with a concrete reason.",
    "- Do not narrate progress in this response.",
    "",
    "Required final response:",
    `- Write the strict JSON final summary to ${shellQuote(finalSummaryPath)} before printing the final marker.`,
    "- The JSON file must contain fields: status, projectId, actionsTaken, delegatedTasks, finalVerification, commits, followUps. delegatedTasks must be an array of strings, or objects with only projectId and status.",
    `- status must be exactly one of: ${SUPERVISOR_FINAL_STATUS_LIST}. Use "completed" for successful no-op runs; do not use "passed", "complete", "done", or "success" as status.`,
    `- Then print ${workOrder.requiredFinalMarker} on its own line. You may print the same strict JSON after it, but the file is authoritative.`,
    '- finalVerification must be one string only: "passed", "failed", "not-run", or "unknown"; put detailed verification notes in actionsTaken or followUps, not in finalVerification.',
    "- commits must contain only real commit hashes or strings that start with a real commit hash; put PR URLs, PR numbers, and status notes in actionsTaken or followUps.",
    "- Before finalizing a PR task, bug-fix task, test-coverage task, or architecture task that opened a PR, re-read the PR body and remove known generated review/release-note blocks such as CodeRabbit auto-generated summaries; the PR body must contain only the intended human-authored summary, verification, and notes.",
  ].join("\n");
}

export function buildLoopSupervisorRevisionPrompt(input: {
  workOrder: LoopWorkOrder;
  failures: string[];
  attempt: number;
  maxAttempts: number;
  previousOutput: string;
}): string {
  const finalSummaryPath = finalSummaryPathForWorkOrder(
    input.workOrder.projectId,
    input.workOrder.id,
  );
  return [
    "You are still the Loop Supervisor for tmux-claude-bot.",
    "",
    "System validation failed for this same WorkOrder. Continue and repair only the listed issues.",
    "",
    `Revision attempt: ${input.attempt} of ${input.maxAttempts}`,
    "",
    "System validation failures:",
    ...input.failures.map((failure) => `- ${failure}`),
    "",
    "WorkOrder JSON:",
    JSON.stringify(input.workOrder, null, 2),
    "",
    "Previous output tail:",
    input.previousOutput.slice(-4000),
    "",
    "Required action now:",
    "- Inspect the target project, PR, CI, and local repository state as needed.",
    "- Fix only the listed validation failures; do not start a new task, branch, or PR.",
    "- Re-run the minimum verification needed for the repaired validation failure.",
    "- Keep the original WorkOrder id, branch, PR, and final marker.",
    "- If you cannot safely repair the issue, report blocked with a concrete reason.",
    "- Do not narrate progress in this response.",
    "",
    "Required final response:",
    `- Write the strict JSON final summary to ${shellQuote(finalSummaryPath)} before printing the final marker.`,
    "- The JSON file must contain fields: status, projectId, actionsTaken, delegatedTasks, finalVerification, commits, followUps. delegatedTasks must be an array of strings, or objects with only projectId and status.",
    `- status must be exactly one of: ${SUPERVISOR_FINAL_STATUS_LIST}. Use "completed" for successful no-op runs; do not use "passed", "complete", "done", or "success" as status.`,
    `- Then print ${input.workOrder.requiredFinalMarker} on its own line. The file is authoritative.`,
    '- finalVerification must be one string only: "passed", "failed", "not-run", or "unknown"; put detailed verification notes in actionsTaken or followUps, not in finalVerification.',
    "- commits must contain only real commit hashes or strings that start with a real commit hash; put PR URLs, PR numbers, and status notes in actionsTaken or followUps.",
  ].join("\n");
}

export function parseSupervisorFinalSummaryFile(
  workOrder: LoopWorkOrder,
): ParseSupervisorFinalSummaryResult {
  if (workOrder.finalSummaryPath === undefined || !existsSync(workOrder.finalSummaryPath)) {
    return { ok: false, reason: "missing-final-marker" };
  }
  try {
    const parsed = JSON.parse(readFileSync(workOrder.finalSummaryPath, "utf8")) as unknown;
    const summary = parseSummaryObject(parsed);
    return summary === null ? { ok: false, reason: "invalid-summary" } : { ok: true, summary };
  } catch {
    return { ok: false, reason: "invalid-summary" };
  }
}

export function parseSupervisorFinalSummary(
  output: string,
  workOrderId: string,
): ParseSupervisorFinalSummaryResult {
  const marker = finalMarkerForWorkOrder(workOrderId);
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) return { ok: false, reason: "missing-final-marker" };

  const rawJson = extractFirstJsonObject(output.slice(markerIndex + marker.length));
  if (rawJson === null) return { ok: false, reason: "invalid-summary" };

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const summary = parseSummaryObject(parsed);
    return summary === null ? { ok: false, reason: "invalid-summary" } : { ok: true, summary };
  } catch {
    return { ok: false, reason: "invalid-summary" };
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

function parseSummaryObject(value: unknown): LoopSupervisorFinalSummary | null {
  if (!isRecord(value)) return null;
  const status = parseSupervisorFinalStatus(value.status);
  const projectId = typeof value.projectId === "string" ? value.projectId : null;
  const actionsTaken = parseStringArray(value.actionsTaken);
  const delegatedTasks = parseDelegatedTasks(value.delegatedTasks);
  const finalVerification = parseFinalVerification(value.finalVerification, status);
  const commits = parseStringArray(value.commits);
  const followUps = parseStringArray(value.followUps);

  if (
    status === null ||
    projectId === null ||
    actionsTaken === null ||
    delegatedTasks === null ||
    finalVerification === null ||
    commits === null ||
    followUps === null
  ) {
    return null;
  }

  return {
    status,
    projectId,
    actionsTaken,
    delegatedTasks,
    finalVerification,
    commits,
    followUps,
  };
}

function parseDelegatedTasks(value: unknown): LoopSupervisorFinalSummary["delegatedTasks"] | null {
  if (!Array.isArray(value)) return null;
  const tasks: LoopSupervisorFinalSummary["delegatedTasks"] = [];
  for (const item of value) {
    if (typeof item === "string") {
      tasks.push(item);
      continue;
    }
    if (!isRecord(item)) return null;
    if (typeof item.projectId === "string") {
      const status = parseSupervisorFinalStatus(item.status);
      if (status === null) return null;
      tasks.push({ projectId: item.projectId, status });
      continue;
    }
    const description = delegatedTaskRecordDescription(item);
    if (description === null) return null;
    tasks.push(description);
  }
  return tasks;
}

function delegatedTaskRecordDescription(item: Record<string, unknown>): string | null {
  const task = typeof item.task === "string" && item.task.trim() ? item.task.trim() : null;
  const result = typeof item.result === "string" && item.result.trim() ? item.result.trim() : null;
  if (task === null && result === null) return null;

  const prefix = Number.isInteger(item.round) ? `Round ${String(item.round)}: ` : "";
  const taskText = task ?? "Delegated task";
  const resultText = result === null ? "" : ` Result: ${result}`;
  return `${prefix}${taskText}${resultText}`;
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function parseSupervisorFinalStatus(value: unknown): SupervisorFinalStatus | null {
  if (typeof value !== "string") return null;
  if (SUPERVISOR_FINAL_STATUSES.has(value as SupervisorFinalStatus)) {
    return value as SupervisorFinalStatus;
  }
  if (value === "passed" || value === "complete") return "completed";
  return null;
}

function parseFinalVerification(
  value: unknown,
  status: SupervisorFinalStatus | null,
): LoopSupervisorFinalSummary["finalVerification"] | null {
  if (
    typeof value === "string" &&
    FINAL_VERIFICATION_STATUSES.has(value as LoopSupervisorFinalSummary["finalVerification"])
  ) {
    return value as LoopSupervisorFinalSummary["finalVerification"];
  }
  if (isRecord(value) && status !== null) {
    if (status === "completed") return "passed";
    if (status === "failed") return "failed";
    return "unknown";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
