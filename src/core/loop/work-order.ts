import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import type { NotificationChannelSelection } from "../notifications/gateway.js";
import { opportunityReportPath } from "../opportunities/store.js";
import { sessionNameFromPath } from "../projects/sessionPathMap.js";
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
  delegatedTasks: Array<{ projectId: string; status: string } | string>;
  finalVerification: "passed" | "failed" | "not-run" | "unknown";
  commits: string[];
  followUps: string[];
};

type HarnessAutoSubtaskKind = "architecture" | "bug-fix" | "test-coverage" | "security-maintenance";
type HarnessAutoSubtask =
  | {
      kind: "architecture";
      enabled: boolean;
      weight: number;
      targetScore: number;
      maxRounds: number;
      prompt?: string;
    }
  | {
      kind: "bug-fix";
      enabled: boolean;
      weight: number;
      maxRounds: number;
      maxBugsPerRound: number;
      requireRegressionTest: boolean;
      prompt?: string;
    }
  | {
      kind: "test-coverage";
      enabled: boolean;
      weight: number;
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
      kind: "security-maintenance";
      enabled: boolean;
      weight: number;
      maxRounds: number;
      allowDependencyUpdates: boolean;
      allowConfigHardening: boolean;
      allowStaticAnalysisFixes: boolean;
      prompt?: string;
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
        kind: "security-maintenance";
        maxRounds: number;
        allowDependencyUpdates: boolean;
        allowConfigHardening: boolean;
        allowStaticAnalysisFixes: boolean;
        prompt?: string;
      }
    | {
        kind: "harness-auto";
        maxRounds: number;
        strategy: "health-first" | "risk-first" | "configured-order";
        stopWhen: {
          healthScoreAtLeast: number;
          noConfirmedIssues: boolean;
        };
        tasks: HarnessAutoSubtask[];
        prompt?: string;
      }
    | {
        kind: "opportunity-discovery";
        maxRounds: number;
        maxSuggestions: number;
        minConfidence: "low" | "medium" | "high";
        categories: string[];
        cooldownDays: number;
        requireEvidence: boolean;
        notificationChannel?: NotificationChannelSelection;
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
      }
    | {
        kind: "active-delegated-task";
        sourceSession: string;
        requirement: string;
        requireReview: boolean;
        requireTests: boolean;
        requireCoverageReview: boolean;
        allowAiEval: boolean;
      };
  projectId: string;
  projectName: string;
  projectPath: string;
  relatedOpportunityIds?: string[];
  notificationSession?: string;
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
  opportunityReportPath?: string;
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
  projectSessionPrefix?: string;
  jobKind?:
    | "architecture"
    | "bug-fix"
    | "test-coverage"
    | "security-maintenance"
    | "harness-auto"
    | "opportunity-discovery"
    | "pull-request-review";
}): LoopWorkOrder {
  const task =
    input.jobKind === "pull-request-review"
      ? pullRequestReviewTask(input.project.pullRequestReview)
      : input.jobKind === "test-coverage"
        ? testCoverageTask(input.project.testCoverage)
        : input.jobKind === "security-maintenance"
          ? securityMaintenanceTask(input.project.securityMaintenance)
          : input.jobKind === "bug-fix"
            ? bugFixTask(input.project.bugFix)
            : input.jobKind === "harness-auto"
              ? harnessAutoTask({
                  policy: input.project.harnessAuto,
                  architecture: {
                    targetScore: input.project.targetScore,
                    maxRounds: input.project.maxRounds,
                  },
                  bugFix: input.project.bugFix,
                  testCoverage: input.project.testCoverage,
                  securityMaintenance: input.project.securityMaintenance,
                })
              : input.jobKind === "opportunity-discovery"
                ? opportunityDiscoveryTask(input.project.opportunityDiscovery)
                : { kind: "architecture" as const };
  const workOrder: LoopWorkOrder = {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    task,
    projectId: input.project.id,
    projectName: input.project.name,
    projectPath: input.project.path,
    ...(input.projectSessionPrefix !== undefined
      ? { notificationSession: sessionNameFromPath(input.project.path, input.projectSessionPrefix) }
      : {}),
    agent: input.project.agent,
    goal: input.project.goal,
    maxRounds:
      task.kind === "bug-fix" ||
      task.kind === "test-coverage" ||
      task.kind === "security-maintenance" ||
      task.kind === "harness-auto" ||
      task.kind === "opportunity-discovery"
        ? task.maxRounds
        : input.project.maxRounds,
    targetScore:
      task.kind === "harness-auto" ? task.stopWhen.healthScoreAtLeast : input.project.targetScore,
    runner: input.project.runner,
    ...actionPolicyForTask(input.project, task),
    skills: { approved: [...input.config.skills.approved] },
    preflight: input.project.preflight,
    assessment:
      task.kind === "opportunity-discovery" ? { command: "true" } : input.project.assessment,
    execution: input.project.execution,
    recovery: input.project.recovery,
    commitPolicy: commitPolicyForWorkOrder(commitPolicyForTask(input.project, task), input.runId),
    pullRequestPolicy: pullRequestPolicyForTask(input.project, task),
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
    finalSummaryPath: finalSummaryPathForWorkOrder(input.project.id, input.runId),
    ...(task.kind === "opportunity-discovery"
      ? { opportunityReportPath: opportunityReportPath(input.project.id, input.runId) }
      : {}),
  };

  if (input.project.eval !== undefined && task.kind !== "opportunity-discovery") {
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
  return buildLoopWorkspaceWorkOrder({ ...input, jobKind: "workspace-architecture" });
}

export function buildLoopWorkspaceWorkOrder(input: {
  config: LoopConfig;
  workspace: LoopWorkspaceConfig;
  scheduledAt: number;
  runId: string;
  projectSessionPrefix?: string;
  jobKind:
    | "workspace-architecture"
    | "bug-fix"
    | "test-coverage"
    | "security-maintenance"
    | "harness-auto"
    | "opportunity-discovery"
    | "pull-request-review";
}): LoopWorkOrder {
  const workspace = input.workspace;
  const task =
    input.jobKind === "pull-request-review"
      ? pullRequestReviewTask(workspace.pullRequestReview)
      : input.jobKind === "test-coverage"
        ? testCoverageTask(workspace.testCoverage)
        : input.jobKind === "security-maintenance"
          ? securityMaintenanceTask(workspace.securityMaintenance)
          : input.jobKind === "bug-fix"
            ? bugFixTask(workspace.bugFix)
            : input.jobKind === "harness-auto"
              ? harnessAutoTask({
                  policy: workspace.harnessAuto,
                  architecture: {
                    targetScore: workspace.architecture.targetScore,
                    maxRounds: workspace.architecture.maxRounds,
                    ...(workspace.architecture.prompt !== undefined
                      ? { prompt: workspace.architecture.prompt }
                      : {}),
                  },
                  bugFix: workspace.bugFix,
                  testCoverage: workspace.testCoverage,
                  securityMaintenance: workspace.securityMaintenance,
                })
              : input.jobKind === "opportunity-discovery"
                ? opportunityDiscoveryTask(workspace.opportunityDiscovery)
                : {
                    kind: "workspace-architecture" as const,
                    ...(workspace.architecture.prompt !== undefined
                      ? { prompt: workspace.architecture.prompt }
                      : {}),
                  };
  const architectureTask = task.kind === "workspace-architecture";
  return {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    task,
    projectId: workspace.id,
    projectName: workspace.name,
    projectPath: workspace.root,
    ...(input.projectSessionPrefix !== undefined
      ? { notificationSession: sessionNameFromPath(workspace.root, input.projectSessionPrefix) }
      : {}),
    agent: workspace.agent,
    goal: architectureTask ? workspace.architecture.goal : workspaceTaskGoal(workspace, task.kind),
    maxRounds: architectureTask
      ? workspace.architecture.maxRounds
      : task.kind === "pull-request-review"
        ? 1
        : task.maxRounds,
    targetScore: workspaceTaskTargetScore(task, workspace.architecture.targetScore),
    runner: workspaceRunnerForTask(workspace, task),
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
    ...(task.kind === "opportunity-discovery"
      ? { opportunityReportPath: opportunityReportPath(workspace.id, input.runId) }
      : {}),
  };
}

export function buildActiveDelegatedTaskWorkOrder(input: {
  session: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  agent: LoopProjectConfig["agent"];
  requirement: string;
  opportunityIds?: string[];
  scheduledAt: number;
  runId: string;
  skills?: { approved: ApprovedSkill[] };
  timeoutMs?: number;
  projectPolicy?: LoopProjectConfig;
}): LoopWorkOrder {
  const projectPolicy = input.projectPolicy;
  return {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    task: {
      kind: "active-delegated-task",
      sourceSession: input.session,
      requirement: input.requirement,
      requireReview: true,
      requireTests: true,
      requireCoverageReview: true,
      allowAiEval: true,
    },
    projectId: input.projectId,
    projectName: input.projectName,
    projectPath: input.projectPath,
    ...(input.opportunityIds !== undefined && input.opportunityIds.length > 0
      ? { relatedOpportunityIds: [...input.opportunityIds] }
      : {}),
    notificationSession: input.session,
    agent: input.agent,
    goal: input.requirement,
    maxRounds: 1,
    targetScore: 100,
    runner: {
      kind: "agent-supervised",
      requireConfirmation: false,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    },
    allowedActions:
      projectPolicy !== undefined
        ? [...projectPolicy.allowedActions]
        : ["tests", "docs", "small-refactor"],
    blockedActions:
      projectPolicy !== undefined
        ? [...projectPolicy.blockedActions]
        : ["direct-model-api", "dependency-upgrade", "broad-rewrite"],
    skills: input.skills ?? { approved: [] },
    preflight: projectPolicy?.preflight ?? { commands: [], repair: { agent: false } },
    assessment: projectPolicy?.assessment ?? { command: "true" },
    execution: projectPolicy?.execution ?? { agent: true },
    recovery: projectPolicy?.recovery ?? { agent: true, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: activeDelegatedCommitPolicy(projectPolicy, input.projectId, input.runId),
    pullRequestPolicy: projectPolicy?.pullRequest ?? {
      enabled: false,
      base: "main",
      switchBack: "main",
      autoMerge: false,
    },
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
    finalSummaryPath: finalSummaryPathForWorkOrder(input.projectId, input.runId),
  };
}

function workspaceTaskGoal(
  workspace: LoopWorkspaceConfig,
  taskKind:
    | "bug-fix"
    | "test-coverage"
    | "security-maintenance"
    | "harness-auto"
    | "opportunity-discovery"
    | "pull-request-review",
): string {
  if (taskKind === "bug-fix") {
    return `Find and fix confirmed cross-repository bugs in ${workspace.name}.`;
  }
  if (taskKind === "test-coverage") {
    return `Improve meaningful test coverage across ${workspace.name}.`;
  }
  if (taskKind === "harness-auto") {
    return `Continuously improve overall health across ${workspace.name}.`;
  }
  if (taskKind === "opportunity-discovery") {
    return `Discover grounded, high-value opportunities across ${workspace.name}.`;
  }
  if (taskKind === "pull-request-review") {
    return `Review and merge eligible pull requests across ${workspace.name}.`;
  }
  return `Find and fix confirmed security issues across ${workspace.name}.`;
}

function workspaceRunnerForTask(
  workspace: LoopWorkspaceConfig,
  _task: NonNullable<LoopWorkOrder["task"]>,
): LoopWorkspaceConfig["runner"] {
  return workspace.runner;
}

function workspaceTaskTargetScore(
  task: NonNullable<LoopWorkOrder["task"]>,
  architectureTargetScore: number,
): number {
  if (task.kind === "workspace-architecture") return architectureTargetScore;
  if (task.kind === "test-coverage") return task.targetCoverage;
  if (task.kind === "harness-auto") return task.stopWhen.healthScoreAtLeast;
  if (task.kind === "opportunity-discovery") return 100;
  return 100;
}

export function buildLoopSupervisorPrompt(workOrder: LoopWorkOrder): string {
  const cli = loopControlCliCommand();
  const baseBranch = baseBranchForWorkOrder(workOrder);
  const finalSummaryPath = finalSummaryPathForWorkOrder(workOrder.projectId, workOrder.id);
  const ghIdentityPolicy = githubIdentityPolicy(workOrder);
  const taskPolicy = [...workspacePolicy(workOrder), ...taskSpecificPolicy(workOrder, baseBranch)];
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
    "- Before finalizing a PR task, bug-fix task, test-coverage task, security-maintenance task, or architecture task that opened a PR, re-read the PR body and remove known generated review/release-note blocks such as CodeRabbit auto-generated summaries; the PR body must contain only the intended human-authored summary, verification, and notes.",
  ].join("\n");
}

function taskSpecificPolicy(workOrder: LoopWorkOrder, baseBranch: string): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind === "pull-request-review") return pullRequestReviewPolicy(workOrder, baseBranch);
  if (task.kind === "repository-pull-request-review")
    return repositoryPullRequestReviewPolicy(workOrder, baseBranch);
  if (task.kind === "workspace-architecture") return workspaceArchitecturePolicy(workOrder);
  if (task.kind === "active-delegated-task") return activeDelegatedTaskPolicy(workOrder);
  if (task.kind === "opportunity-discovery") return opportunityDiscoveryPolicy(workOrder);
  if (task.kind === "test-coverage") return testCoveragePolicy(workOrder);
  if (task.kind === "security-maintenance") return securityMaintenancePolicy(workOrder);
  if (task.kind === "bug-fix") return bugFixPolicy(workOrder);
  if (task.kind === "harness-auto") return harnessAutoPolicy(workOrder);
  return architecturePolicy(workOrder);
}

function harnessAutoTask(input: {
  policy: LoopProjectConfig["harnessAuto"];
  architecture: {
    targetScore: number;
    maxRounds: number;
    prompt?: string;
  };
  bugFix: LoopProjectConfig["bugFix"];
  testCoverage: LoopProjectConfig["testCoverage"];
  securityMaintenance: LoopProjectConfig["securityMaintenance"];
}): Extract<LoopWorkOrder["task"], { kind: "harness-auto" }> {
  const byKind = new Map(input.policy.tasks.map((task) => [task.kind, task]));
  const taskConfig = (kind: HarnessAutoSubtaskKind): { enabled: boolean; weight: number } => {
    const configured = byKind.get(kind);
    return {
      enabled: configured?.enabled ?? false,
      weight: configured?.weight ?? 1,
    };
  };
  const architectureConfig = taskConfig("architecture");
  const bugFixConfig = taskConfig("bug-fix");
  const testCoverageConfig = taskConfig("test-coverage");
  const securityConfig = taskConfig("security-maintenance");
  const bugFix = bugFixTask(input.bugFix);
  const testCoverage = testCoverageTask(input.testCoverage);
  const securityMaintenance = securityMaintenanceTask(input.securityMaintenance);
  const tasks = [
    {
      kind: "bug-fix" as const,
      enabled: bugFixConfig.enabled,
      weight: bugFixConfig.weight,
      maxRounds: bugFix.maxRounds,
      maxBugsPerRound: bugFix.maxBugsPerRound,
      requireRegressionTest: bugFix.requireRegressionTest,
      ...(bugFix.prompt !== undefined ? { prompt: bugFix.prompt } : {}),
    },
    {
      kind: "security-maintenance" as const,
      enabled: securityConfig.enabled,
      weight: securityConfig.weight,
      maxRounds: securityMaintenance.maxRounds,
      allowDependencyUpdates: securityMaintenance.allowDependencyUpdates,
      allowConfigHardening: securityMaintenance.allowConfigHardening,
      allowStaticAnalysisFixes: securityMaintenance.allowStaticAnalysisFixes,
      ...(securityMaintenance.prompt !== undefined ? { prompt: securityMaintenance.prompt } : {}),
    },
    {
      kind: "test-coverage" as const,
      enabled: testCoverageConfig.enabled,
      weight: testCoverageConfig.weight,
      targetCoverage: testCoverage.targetCoverage,
      maxRounds: testCoverage.maxRounds,
      requireMeaningfulTests: testCoverage.requireMeaningfulTests,
      allowIntegrationTests: testCoverage.allowIntegrationTests,
      allowSmokeTests: testCoverage.allowSmokeTests,
      allowE2ETests: testCoverage.allowE2ETests,
      allowAiEvalTests: testCoverage.allowAiEvalTests,
      ...(testCoverage.prompt !== undefined ? { prompt: testCoverage.prompt } : {}),
    },
    {
      kind: "architecture" as const,
      enabled: architectureConfig.enabled,
      weight: architectureConfig.weight,
      targetScore: input.architecture.targetScore,
      maxRounds: input.architecture.maxRounds,
      ...(input.architecture.prompt !== undefined ? { prompt: input.architecture.prompt } : {}),
    },
  ] satisfies HarnessAutoSubtask[];
  const orderedTasks = [...tasks].sort((left, right) => {
    const leftIndex = input.policy.tasks.findIndex((task) => task.kind === left.kind);
    const rightIndex = input.policy.tasks.findIndex((task) => task.kind === right.kind);
    return normalizeTaskOrder(leftIndex) - normalizeTaskOrder(rightIndex);
  });
  return {
    kind: "harness-auto",
    maxRounds: input.policy.maxRounds,
    strategy: input.policy.strategy,
    stopWhen: input.policy.stopWhen,
    tasks: orderedTasks,
    ...(input.policy.prompt !== undefined ? { prompt: input.policy.prompt } : {}),
  };
}

function normalizeTaskOrder(index: number): number {
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
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

function securityMaintenanceTask(
  policy: LoopProjectConfig["securityMaintenance"],
): Extract<LoopWorkOrder["task"], { kind: "security-maintenance" }> {
  return {
    kind: "security-maintenance",
    maxRounds: policy.maxRounds,
    allowDependencyUpdates: policy.allowDependencyUpdates,
    allowConfigHardening: policy.allowConfigHardening,
    allowStaticAnalysisFixes: policy.allowStaticAnalysisFixes,
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

function opportunityDiscoveryTask(
  policy: LoopProjectConfig["opportunityDiscovery"],
): Extract<LoopWorkOrder["task"], { kind: "opportunity-discovery" }> {
  return {
    kind: "opportunity-discovery",
    maxRounds: 1,
    maxSuggestions: policy.maxSuggestions,
    minConfidence: policy.minConfidence,
    categories: [...policy.categories],
    cooldownDays: policy.cooldownDays,
    requireEvidence: policy.requireEvidence,
    ...(policy.notificationChannel !== undefined
      ? { notificationChannel: policy.notificationChannel }
      : {}),
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
  if (workOrder.task?.kind === "active-delegated-task") {
    if (workOrder.commitPolicy.enabled && workOrder.pullRequestPolicy?.enabled) {
      return `- Before delegated work, sync the target base branch: cd ${shellQuote(workOrder.projectPath)} && git status --short must be clean, then git fetch origin ${baseBranch}, git switch ${baseBranch}, and git pull --ff-only origin ${baseBranch}.`;
    }
    return [
      "- Before delegated work, inspect the target repository state from the current branch and preserve the user's active branch context.",
      `- Run git status --short in ${shellQuote(workOrder.projectPath)} and record whether unrelated user work is present before editing.`,
      "- Do not switch branches, pull, rebase, merge, or discard local changes unless the user requirement explicitly asks for it or it is necessary and safe to complete the delegated task.",
    ].join("\n");
  }
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

function workspacePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (workOrder.workspace === undefined) return [];
  const branchKind = task.kind === "workspace-architecture" ? "architecture" : task.kind;
  return [
    "Workspace multi-repository task.",
    `- Treat ${workOrder.projectName} as one bounded workspace with ${workOrder.workspace.repositories.length} repositories.`,
    "- First decide which repositories are actually affected. Do not force every repository to change. When the evidence points to only one repository, keep the change there.",
    "- Inspect contracts between repositories before editing affected areas: API routes, schemas, generated clients, shared DTOs, auth/session assumptions, build/deploy coupling, error handling, and data/state ownership.",
    "- If a change crosses repository boundaries, update all affected repositories in the same round and verify the contract from every affected side.",
    "- Each repository keeps its own git branch and pull request. Use one shared run id, link the related PRs in every PR body, and describe the cross-repository reason clearly.",
    ...workOrder.workspace.repositories.map(
      (repository) =>
        `- For ${repository.id}, use branch loop/${repository.id}/${branchKind}/${workOrder.id}, open the PR against ${repository.pullRequest.base}, switch back to ${repository.pullRequest.switchBack}, and ${workspaceGithubPolicy(repository)}.`,
    ),
    "- Before finalizing, verify every changed repository is on its configured switch-back branch, clean, and has a human-readable PR body without generated review/release-note blocks.",
  ];
}

function workspaceArchitecturePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "workspace-architecture" || workOrder.workspace === undefined) return [];
  return [
    "Workspace architecture task.",
    `- Architecture target score is ${workOrder.targetScore}; if the cross-repository evaluation reaches or exceeds it, stop instead of optimizing for its own sake.`,
    "- Prefer the smallest set of repository changes that improves the whole workspace. Do not force every repository to change.",
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
    "- Separate candidate bugs from confirmed bugs: list candidates first, then fix only candidates with enough evidence to confirm real impact.",
    "- For every confirmed bug, record a concise evidence chain: entry point or trigger, affected path, expected behavior, actual behavior, impact, and any preconditions or limits.",
    "- Before editing, prove the issue is real by recording the trigger path, affected behavior, and why it is not merely a preference or theoretical concern.",
    "- If the impact depends on another boundary layer, such as a caller, callee, API, worker, scheduler, database constraint, or frontend/backend pair, inspect that boundary before confirming the bug.",
    "- Before editing, perform an independent verification pass from the current final code state and calling path; if that pass cannot reconstruct the bug mechanism, skip the candidate.",
    "- If a suspected issue cannot be proven as a real functional or reliability risk, record it as a deferred candidate or skipped candidate and do not edit for it.",
    "- Keep each repair small, local, and consistent with existing project patterns.",
    task.requireRegressionTest
      ? "- Add or update a focused regression test for every code bug you fix. If a regression test is genuinely impossible, record the reason and use the narrowest available verification instead."
      : "- Prefer focused regression tests for fixed bugs, but follow the configured project verification contract when tests are impractical.",
    "- After each repair, independently re-check the same evidence chain: the original trigger path is blocked, expected behavior now holds, and the diff did not add feature work, unrelated refactors, or a new functional risk; then run the relevant checks.",
    "- When no confirmed bug is fixed, still report the checked areas, skipped areas, deferred candidates, and whether coverage was complete, partial, or unknown; zero fixes with partial coverage must not be presented as proof that the project has no bugs.",
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

function securityMaintenancePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "security-maintenance") return [];
  return [
    "Security maintenance task.",
    `- Run at most ${task.maxRounds} focused security round(s). Stop when no confirmed actionable security issue remains within this task's allowed scope.`,
    "- Check broadly for security risk, not only dependency advisories: dependency vulnerabilities, GitHub security findings, static analysis findings, secret or token exposure, unsafe auth/permission checks, webhook verification, CORS, file/path handling, uploads, deserialization/parsing, SSRF, command execution, logging of sensitive data, CI secret handling, and supply-chain risk.",
    "- Start with the project's own security signals when available: npm/pnpm/yarn/bun audit, GitHub Dependabot/security alerts, CodeQL, Semgrep, ESLint security rules, existing CI/security scripts, and repository documentation.",
    "- Before editing, prove the issue is real or plausibly reachable in this project. Record the evidence, affected path, severity, reachability, and why it is not merely a scanner false positive.",
    "- Do not add product features, broad rewrites, cosmetic cleanup, speculative hardening, unrelated test coverage, or dependency churn just to quiet a report.",
    task.allowDependencyUpdates
      ? "- Dependency updates are allowed only when they address a confirmed security issue or safe supply-chain maintenance; prefer the smallest compatible update and inspect changelogs or release notes when risk is non-trivial."
      : "- Do not perform dependency updates; classify dependency findings and report blockers instead.",
    task.allowConfigHardening
      ? "- Config hardening is allowed when it directly reduces a confirmed exposure and preserves documented deployment behavior."
      : "- Do not change runtime, CI, or deployment configuration; classify config findings and report blockers instead.",
    task.allowStaticAnalysisFixes
      ? "- Static analysis fixes are allowed when they correct a real security-sensitive behavior or remove a high-signal finding without weakening checks."
      : "- Do not edit code solely for static analysis findings; report them with evidence and blockers.",
    "- For every fix, add or update a focused regression, smoke, or security test when practical. If a test is not practical, record the narrow verification command and manual reasoning.",
    "- After each fix, rerun the relevant security check plus the normal local verification required by the project, then inspect the diff for new security, compatibility, or operational risk.",
    "- PR content must clearly separate: finding source, severity/reachability judgment, fix, verification, and any accepted residual risk.",
    task.prompt !== undefined
      ? `- Additional security-maintenance instruction: ${task.prompt}`
      : "",
  ].filter(Boolean);
}

function harnessAutoPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "harness-auto") return [];
  const enabledTasks = task.tasks.filter((subtask) => subtask.enabled);
  return [
    "Harness-auto health orchestration task.",
    `- Run at most ${task.maxRounds} harness round(s). Each harness round starts with a fresh project health assessment, then chooses the highest-value enabled subtask(s) for that current state.`,
    `- Strategy is ${task.strategy}. health-first means maximize overall project health; risk-first means prioritize confirmed production/security/reliability risk; configured-order means preserve the configured task order unless current evidence clearly proves a blocker.`,
    `- Stop when health score is at least ${task.stopWhen.healthScoreAtLeast}${task.stopWhen.noConfirmedIssues ? " and no confirmed actionable issue remains in the enabled task scope" : ""}.`,
    "- Do not run all subtasks mechanically. Choose only subtasks justified by evidence from the current codebase and verification signals.",
    "- Start each round by recording: current branch state, recent failures or stale PR context, available test/security/coverage/architecture signals, candidate issues, enabled subtasks considered, selected subtask(s), and why lower-priority subtasks were skipped.",
    "- A no-op is valid when the stop condition is met or no enabled subtask has a confirmed actionable improvement. Report the checked signals and stop cleanly instead of optimizing for its own sake.",
    "- Keep the whole harness run on one run id and one PR branch/PR per repository. Do not split bug-fix, security, coverage, and architecture work into separate PRs for the same harness run.",
    "- If multiple subtasks touch the same area, sequence them deliberately: fix confirmed bugs/security issues first, add or update regression/coverage tests next, then make architecture cleanup only when the behavior is protected.",
    "- Before each edit, prove the selected subtask has a real reason. After each edit, re-check the exact evidence chain and run the narrowest relevant verification plus the normal project verification when available.",
    "- PR content must clearly list the harness assessment, selected subtasks, skipped subtasks with reasons, changes made, verification, remaining risk, and stop condition result.",
    `- Enabled subtasks: ${enabledTasks.map((subtask) => `${subtask.kind}(weight=${subtask.weight})`).join(", ") || "none"}.`,
    task.prompt !== undefined ? `- Additional harness-auto instruction: ${task.prompt}` : "",
    ...harnessSubtaskPolicies(workOrder, enabledTasks),
  ].filter(Boolean);
}

function opportunityDiscoveryPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "opportunity-discovery") return [];
  const reportPath =
    workOrder.opportunityReportPath ?? opportunityReportPath(workOrder.projectId, workOrder.id);
  return [
    "Opportunity discovery task.",
    "- This task must discover and propose valuable opportunities only; do not edit files, commit, push, create branches, create PRs, or change project state.",
    "- Think like a senior employee proposing focused work to the owner: surface decisions, not busywork.",
    `- Produce at most ${task.maxSuggestions} suggestion(s). Fewer is better when the evidence is weak.`,
    `- Minimum confidence is ${task.minConfidence}; do not include lower-confidence ideas.`,
    `- Allowed categories: ${task.categories.join(", ")}.`,
    task.requireEvidence
      ? "- Every suggestion must cite concrete evidence from the repository, docs, logs, recent failures, TODOs, repeated manual workflows, tests, scripts, or existing UX. Do not invent product direction."
      : "- Prefer concrete evidence; clearly label any suggestion whose evidence is incomplete.",
    "- A suggestion is reportable only when it has a clear user or engineering value, bounded implementation scope, acceptance criteria, non-goals, and a realistic verification path.",
    "- Avoid vague ideas, vanity features, broad rewrites, large product pivots, purely stylistic cleanup, speculative architecture preferences, or suggestions whose only value is making code look different.",
    "- Prefer small or medium opportunities that can be implemented by a later active delegated task in one coherent PR.",
    "- Include simple options or alternatives when useful, but mark one recommended approach.",
    "- The owner will decide whether to discuss or delegate. Do not start implementation in this WorkOrder.",
    `- Write the opportunity report JSON to ${shellQuote(reportPath)} before finalizing.`,
    "- The JSON file must contain exactly: projectId, projectName, generatedAt, coverage, checkedSignals, skippedSignals, suggestions.",
    '- coverage must be one of "complete", "partial", or "unknown".',
    "- suggestions must be an array of objects with: title, category, confidence, problem, whyNow, value, evidence, recommendedApproach, alternatives, acceptanceCriteria, risks, nonGoals, estimatedComplexity, delegateRequirement.",
    '- category must be one of "product-feature", "workflow-automation", "developer-experience", "reliability", "architecture", "testing", "security".',
    '- confidence must be one of "low", "medium", "high"; estimatedComplexity must be one of "small", "medium", "large".',
    "- delegateRequirement must be the clear implementation brief that will be handed to /autopilot delegate after owner approval.",
    task.prompt !== undefined
      ? `- Additional opportunity-discovery instruction: ${task.prompt}`
      : "",
  ].filter(Boolean);
}

function harnessSubtaskPolicies(
  workOrder: LoopWorkOrder,
  enabledTasks: HarnessAutoSubtask[],
): string[] {
  const sections: string[] = [];
  for (const subtask of enabledTasks) {
    const pseudoWorkOrder = workOrderForHarnessSubtask(workOrder, subtask);
    if (subtask.kind === "architecture") {
      sections.push(
        "Harness subtask policy: architecture.",
        ...(workOrder.workspace === undefined
          ? architecturePolicy(pseudoWorkOrder)
          : workspaceArchitecturePolicy(pseudoWorkOrder)),
      );
    } else if (subtask.kind === "bug-fix") {
      sections.push("Harness subtask policy: bug-fix.", ...bugFixPolicy(pseudoWorkOrder));
    } else if (subtask.kind === "test-coverage") {
      sections.push(
        "Harness subtask policy: test-coverage.",
        ...testCoveragePolicy(pseudoWorkOrder),
      );
    } else {
      sections.push(
        "Harness subtask policy: security-maintenance.",
        ...securityMaintenancePolicy(pseudoWorkOrder),
      );
    }
  }
  return sections;
}

function workOrderForHarnessSubtask(
  workOrder: LoopWorkOrder,
  subtask: HarnessAutoSubtask,
): LoopWorkOrder {
  if (subtask.kind === "architecture") {
    return {
      ...workOrder,
      task:
        workOrder.workspace === undefined
          ? { kind: "architecture" }
          : {
              kind: "workspace-architecture",
              ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
            },
      targetScore: subtask.targetScore,
      maxRounds: subtask.maxRounds,
    };
  }
  return {
    ...workOrder,
    task: harnessSubtaskAsWorkOrderTask(subtask),
    maxRounds: subtask.maxRounds,
  };
}

function harnessSubtaskAsWorkOrderTask(
  subtask: Exclude<HarnessAutoSubtask, { kind: "architecture" }>,
): NonNullable<LoopWorkOrder["task"]> {
  if (subtask.kind === "bug-fix") {
    return {
      kind: "bug-fix",
      maxRounds: subtask.maxRounds,
      maxBugsPerRound: subtask.maxBugsPerRound,
      requireRegressionTest: subtask.requireRegressionTest,
      ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
    };
  }
  if (subtask.kind === "test-coverage") {
    return {
      kind: "test-coverage",
      targetCoverage: subtask.targetCoverage,
      maxRounds: subtask.maxRounds,
      requireMeaningfulTests: subtask.requireMeaningfulTests,
      allowIntegrationTests: subtask.allowIntegrationTests,
      allowSmokeTests: subtask.allowSmokeTests,
      allowE2ETests: subtask.allowE2ETests,
      allowAiEvalTests: subtask.allowAiEvalTests,
      ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
    };
  }
  return {
    kind: "security-maintenance",
    maxRounds: subtask.maxRounds,
    allowDependencyUpdates: subtask.allowDependencyUpdates,
    allowConfigHardening: subtask.allowConfigHardening,
    allowStaticAnalysisFixes: subtask.allowStaticAnalysisFixes,
    ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
  };
}

function pullRequestReviewPolicy(workOrder: LoopWorkOrder, baseBranch: string): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "pull-request-review") return [];
  if (workOrder.workspace !== undefined) {
    const repositories = workOrder.workspace.repositories
      .filter((repository) => repository.pullRequest.enabled)
      .map(
        (repository) =>
          `${repository.id}(${repository.pullRequest.base}->${repository.pullRequest.switchBack}, autoMerge=${repository.pullRequest.autoMerge})`,
      )
      .join(", ");
    return [
      "Workspace pull request review and merge task.",
      `- Review open loop-created PRs across this workspace's PR-enabled repositories: ${repositories || "none"}.`,
      "- Treat loop-created PRs as PRs whose head branch starts with loop/ or whose title/body clearly identifies Loop Engineering.",
      `- Prioritize PRs created or updated within the last ${task.lookbackHours} hours.`,
      `- Run two independent review passes for each candidate PR. Merge only when ${task.consecutivePasses} consecutive passes find no bug, CI, mergeability, data loss, security, migration, dependency, deployment, or user-visible regression risk.`,
      "- Do not nitpick style, naming, wording, formatting, or harmless refactors. Focus on whether the PR introduced a real bug or operational risk.",
      "- Inspect each repository's PR diff, files changed, commits, review comments, mergeability, and CI/status checks before deciding.",
      "- If checks are pending, inconclusive, failing, required reviews are missing, the PR is a draft, mergeability is unknown/conflicting, or the branch is behind in a way GitHub cannot update safely, do not merge; record the exact blocker.",
      task.autoMerge
        ? "- If both review passes pass and CI/status checks are successful, merge the PR according to that repository's pullRequest policy, then sync the repository's local switch-back branch."
        : "- Do not merge automatically; report the review decision only.",
      '- Final status may be "completed" only after every in-scope workspace PR has a recorded review decision.',
      task.prompt !== undefined ? `- Additional review instruction: ${task.prompt}` : "",
    ].filter(Boolean);
  }
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

function activeDelegatedTaskPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "active-delegated-task") return [];
  const pullRequestPolicy =
    workOrder.pullRequestPolicy?.enabled === true ? workOrder.pullRequestPolicy : null;
  const projectManagedPr =
    workOrder.commitPolicy.enabled &&
    workOrder.commitPolicy.branch !== undefined &&
    pullRequestPolicy !== null;
  return [
    "Active delegated task.",
    `- This is a user-confirmed interactive task handed off from session ${task.sourceSession}; it is not a cron maintenance run.`,
    `- Requirement: ${task.requirement}`,
    "- Treat the requirement as bounded. If the current session context is needed, inspect the target project with tcb peek/history or ask the target agent to summarize the agreed requirement before editing.",
    "- Drive the target project agent until the requested behavior is implemented or a real blocker is proven. Do not stop at a plan, partial implementation, or one failed check.",
    "- Work in explicit slices: confirm the intended behavior, implement the smallest coherent slice, run the relevant checks, review the diff, then continue to the next slice.",
    "- Preserve unrelated user work and do not introduce broad rewrites, new product scope, dependency churn, or direct model-provider integrations.",
    task.requireReview
      ? "- Before finalizing, perform an independent review pass focused on introduced bugs, behavior regressions, data loss, security, migration/config risk, and user-visible breakage; fix confirmed issues and repeat the review."
      : "- A final review pass is optional for this WorkOrder.",
    task.requireTests
      ? "- Run the target project's relevant tests or local verification. If no reliable test command exists, record the exact checked surface and why stronger verification is unavailable."
      : "- Tests are optional for this WorkOrder, but record any verification you do run.",
    task.requireCoverageReview
      ? "- Review test coverage for the touched behavior and risk paths. Add meaningful unit, integration, smoke, E2E, or regression tests where justified; do not add weak tests just to move a metric."
      : "- Coverage review is optional for this WorkOrder.",
    task.allowAiEval
      ? "- If the project already has an agent-backed or deterministic AI eval surface relevant to the touched behavior, run or update it when justified. Do not add direct model API calls, model SDKs, or model API keys."
      : "- Do not add or run AI eval work for this WorkOrder.",
    projectManagedPr
      ? `- This delegated task inherits the target project's PR policy: branch from ${pullRequestPolicy.base}, use ${workOrder.commitPolicy.branch}, open or update one PR against ${pullRequestPolicy.base}, verify CI and mergeability, ${pullRequestPolicy.autoMerge ? "allow auto-merge only after all gates pass" : "leave the PR open after checks"}, then switch the local worktree back to ${pullRequestPolicy.switchBack} and fast-forward it.`
      : "- No project PR policy was matched for this delegated task; preserve the current branch and do not create commits or PRs unless the user requirement explicitly asks for it.",
    "- Final status may be completed only after implementation, review, verification, and any justified coverage/eval work are done or explicitly recorded as not applicable.",
  ];
}

function agentSessionPolicy(workOrder: LoopWorkOrder, cli: string): string[] {
  const task = workOrderTask(workOrder);
  if (workOrder.workspace !== undefined) {
    return [
      "- This workspace task may delegate to multiple real project sessions; do not create a synthetic workspace product session.",
      ...workOrder.workspace.repositories.flatMap((repository) => [
        `- Open ${repository.name} with the configured agent: ${cli} open ${repository.id} --agent ${repository.agent}.`,
        `- After opening ${repository.id}, verify ${cli} dashboard --json shows that real project running with the configured agent.`,
      ]),
      contextResetPolicy(workOrder, cli),
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
    `- Open the target project with the configured agent: ${cli} open ${shellQuote(workOrder.projectPath)} --agent ${workOrder.agent}.`,
    `- After opening, verify ${cli} dashboard --json shows the target project running with the configured agent; if it does not, stop and report blocked.`,
    contextResetPolicy(workOrder, cli),
  ];
}

function commitBranchPolicy(workOrder: LoopWorkOrder): string {
  const task = workOrderTask(workOrder);
  if (task.kind === "active-delegated-task") {
    if (workOrder.commitPolicy.enabled && workOrder.commitPolicy.branch !== undefined) {
      return `- Use the WorkOrder commitPolicy.branch exactly: ${workOrder.commitPolicy.branch}. Do not reuse or merge any other delegated branch.`;
    }
    return "- This active delegated task must preserve the user's current branch by default; commit or PR only if the user requirement or later project policy explicitly asks for it.";
  }
  if (task.kind === "opportunity-discovery") {
    return "- This opportunity discovery task must not create a branch, commit, PR, or code change.";
  }
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
  if (task.kind === "security-maintenance") {
    return `- Run ${cli} control <project> compact --yes before each delegated security-maintenance round.`;
  }
  if (task.kind === "harness-auto") {
    return `- Run ${cli} control <project> compact --yes before each delegated harness-auto round and before switching between different subtask types.`;
  }
  if (task.kind === "active-delegated-task") {
    return `- Run ${cli} control <project> compact --yes before each delegated task slice when context is stale or before a major verification/review pass.`;
  }
  if (task.kind === "opportunity-discovery") {
    return `- Run ${cli} control <project> compact --yes before the discovery pass if the target session context is stale.`;
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
  if (task.kind === "opportunity-discovery") {
    return { enabled: false, perRound: false };
  }
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
  if (task.kind === "security-maintenance" && project.securityMaintenance.branch !== undefined) {
    return {
      ...project.commit,
      branch: project.securityMaintenance.branch,
    };
  }
  if (task.kind === "harness-auto" && project.harnessAuto.branch !== undefined) {
    return {
      ...project.commit,
      branch: project.harnessAuto.branch,
    };
  }
  return project.commit;
}

function pullRequestPolicyForTask(
  project: LoopProjectConfig,
  task: NonNullable<LoopWorkOrder["task"]>,
): LoopProjectConfig["pullRequest"] {
  if (task.kind === "opportunity-discovery") {
    return {
      ...project.pullRequest,
      enabled: false,
      autoMerge: false,
    };
  }
  return project.pullRequest;
}

function activeDelegatedCommitPolicy(
  project: LoopProjectConfig | undefined,
  projectId: string,
  runId: string,
): LoopProjectConfig["commit"] {
  if (project === undefined || !project.commit.enabled || !project.pullRequest.enabled) {
    return { enabled: false, perRound: false };
  }
  return commitPolicyForWorkOrder(
    {
      ...project.commit,
      perRound: false,
      branch: `loop/${sanitizeBranchSegment(projectId)}/active-delegate`,
    },
    runId,
  );
}

function actionPolicyForTask(
  project: LoopProjectConfig,
  task: NonNullable<LoopWorkOrder["task"]>,
): Pick<LoopWorkOrder, "allowedActions" | "blockedActions"> {
  const allowsDependencyUpdates =
    task.kind === "security-maintenance"
      ? task.allowDependencyUpdates
      : task.kind === "harness-auto"
        ? task.tasks.some(
            (subtask) =>
              subtask.enabled &&
              subtask.kind === "security-maintenance" &&
              subtask.allowDependencyUpdates,
          )
        : false;
  if (!allowsDependencyUpdates) {
    return {
      allowedActions: [...project.allowedActions],
      blockedActions: [...project.blockedActions],
    };
  }
  return {
    allowedActions: [...new Set([...project.allowedActions, "dependency-upgrade"])],
    blockedActions: project.blockedActions.filter((action) => action !== "dependency-upgrade"),
  };
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
  const command =
    existsSync(tsxBin) && existsSync(sourceCli)
      ? `${shellQuote(tsxBin)} ${shellQuote(sourceCli)}`
      : "tcb";
  return `TCB_STATE_DIR=${shellQuote(appStateDir())} ${command}`;
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
    "- Before finalizing a PR task, bug-fix task, test-coverage task, security-maintenance task, or architecture task that opened a PR, re-read the PR body and remove known generated review/release-note blocks such as CodeRabbit auto-generated summaries; the PR body must contain only the intended human-authored summary, verification, and notes.",
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
      const status = typeof item.status === "string" && item.status.trim() ? item.status : null;
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
