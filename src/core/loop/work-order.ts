import { existsSync } from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { opportunityReportPath } from "../opportunities/store.js";
import { loopWorkerRunSessionName } from "../projects/operator.js";
import { sessionNameFromPath } from "../projects/sessionPathMap.js";
import {
  buildLoopTaskPolicyLines,
  buildLoopWorkspacePolicyLines,
} from "../prompts/loop-task-policies.js";
import type { ApprovedSkill } from "../skills/schema.js";
import { loopRunArtifactPath } from "./artifacts.js";
import type {
  LoopConfig,
  LoopProjectConfig,
  LoopRepositoryPullRequestReviewConfig,
  LoopWorkspaceConfig,
} from "./config.js";
import { finalMarkerForWorkOrder, SUPERVISOR_FINAL_STATUS_LIST } from "./final-summary-contract.js";
import { defaultActiveDelegationPlanning, type LoopWorkOrderPlanning } from "./planning.js";
import type {
  HarnessAutoSubtask,
  HarnessAutoSubtaskKind,
  LoopCleanupPolicy,
  LoopExecutionIsolation,
  LoopWorkOrder,
  LoopWorktreeIsolationMode,
} from "./work-order-contract.js";

export {
  finalMarkerForWorkOrder,
  parseSupervisorFinalSummary,
  parseSupervisorFinalSummaryFile,
  validateSupervisorFinalSummaryForWorkOrder,
} from "./final-summary-contract.js";
export type {
  LoopSupervisorFinalSummary,
  LoopSupervisorReviewGateDeterministicGate,
  LoopWorkOrder,
  LoopWorktreeIsolationMode,
} from "./work-order-contract.js";

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
    | "automation-governance-review"
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
                : input.jobKind === "automation-governance-review"
                  ? automationGovernanceReviewTask(input.project.automationGovernanceReview)
                  : { kind: "architecture" as const };
  const workOrder: LoopWorkOrder = {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    task,
    projectId: input.project.id,
    projectName: input.project.name,
    projectPath: input.project.path,
    cleanupPolicy: cleanupPolicyForProjectTask(input.project, task),
    executionIsolation: configuredExecutionIsolation(
      input.project.path,
      input.project.worktreeIsolation,
    ),
    ...(input.projectSessionPrefix !== undefined
      ? {
          notificationSession: sessionNameFromPath(input.project.path, input.projectSessionPrefix),
          workerSession: loopWorkerRunSessionName(
            input.projectSessionPrefix,
            input.project.id,
            input.runId,
          ),
        }
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
      task.kind === "harness-auto"
        ? task.stopWhen.healthScoreAtLeast
        : task.kind === "automation-governance-review"
          ? task.targetScore
          : input.project.targetScore,
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
    ...(task.kind === "automation-governance-review"
      ? { governance: automationGovernancePolicy(task) }
      : {}),
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
    cleanupPolicy: "conservative",
    executionIsolation: configuredExecutionIsolation(repository.path, repository.worktreeIsolation),
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
      mergeMethod: repository.mergeMethod,
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
  projectSessionPrefix?: string;
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
                    cleanupPolicy: workspace.architecture.cleanupPolicy ?? workspace.cleanupPolicy,
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
    cleanupPolicy: cleanupPolicyForWorkspaceTask(workspace, task),
    executionIsolation: configuredExecutionIsolation(workspace.root, workspace.worktreeIsolation),
    ...(input.projectSessionPrefix !== undefined
      ? {
          notificationSession: sessionNameFromPath(workspace.root, input.projectSessionPrefix),
          workerSession: loopWorkerRunSessionName(
            input.projectSessionPrefix,
            workspace.id,
            input.runId,
          ),
        }
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
    pullRequestPolicy: {
      enabled: false,
      base: "main",
      switchBack: "main",
      autoMerge: false,
      mergeMethod: "squash",
    },
    workspace: {
      root: workspace.root,
      repositories: workspace.repositories.map((repository) => ({
        id: repository.id,
        name: repository.name,
        path: repository.path,
        ...repositoryWorktreeIsolationPolicy(repository, workspace),
        role: repository.role,
        agent: repository.agent ?? workspace.agent,
        pullRequest: repository.pullRequest,
        ...(input.projectSessionPrefix !== undefined
          ? {
              workerSession: loopWorkerRunSessionName(
                input.projectSessionPrefix,
                repository.id,
                input.runId,
              ),
            }
          : {}),
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
  projectSessionPrefix?: string;
  projectPolicy?: LoopProjectConfig;
  planning?: LoopWorkOrderPlanning;
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
    cleanupPolicy: projectPolicy?.cleanupPolicy ?? "conservative",
    planning: input.planning ?? defaultActiveDelegationPlanning(),
    executionIsolation: configuredExecutionIsolation(
      input.projectPath,
      input.projectPolicy?.worktreeIsolation,
    ),
    ...(input.opportunityIds !== undefined && input.opportunityIds.length > 0
      ? { relatedOpportunityIds: [...input.opportunityIds] }
      : {}),
    notificationSession: input.session,
    ...(input.projectSessionPrefix !== undefined
      ? {
          workerSession: loopWorkerRunSessionName(
            input.projectSessionPrefix,
            input.projectId,
            input.runId,
          ),
        }
      : {}),
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
    preflight: activeDelegatedPreflight(input.requirement, projectPolicy),
    assessment: projectPolicy?.assessment ?? { command: "true" },
    execution: projectPolicy?.execution ?? { agent: true },
    recovery: projectPolicy?.recovery ?? { agent: true, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: activeDelegatedCommitPolicy(projectPolicy, input.projectId, input.runId),
    pullRequestPolicy: projectPolicy?.pullRequest ?? {
      enabled: false,
      base: "main",
      switchBack: "main",
      autoMerge: false,
      mergeMethod: "squash",
    },
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
    finalSummaryPath: finalSummaryPathForWorkOrder(input.projectId, input.runId),
  };
}

function defaultExecutionIsolation(expectedWorktree: string): LoopExecutionIsolation {
  return {
    mode: "supervised-worker",
    expectedWorktree,
    worktreeIsolation: "auto",
    contextReset: "compact",
    cleanup: {
      success: "release-worker",
      failure: "retain-for-ttl",
      retainFailureForHours: 72,
    },
  };
}

function activeDelegatedPreflight(
  requirement: string,
  projectPolicy: LoopProjectConfig | undefined,
): LoopProjectConfig["preflight"] {
  const preflight = projectPolicy?.preflight ?? { commands: [], repair: { agent: false } };
  if (!isReadOnlySmokeRequirement(requirement)) return preflight;

  const commands = preflight.commands.filter((command) => !isDependencyPreflightCommand(command));
  if (commands.length !== preflight.commands.length) {
    return { commands, repair: { agent: false } };
  }
  return preflight;
}

function isReadOnlySmokeRequirement(requirement: string): boolean {
  const normalized = requirement.toLowerCase();
  return (
    normalized.includes("read-only smoke") &&
    normalized.includes("do not modify files") &&
    normalized.includes("do not commit") &&
    (normalized.includes("do not open a pr") || normalized.includes("do not open a pull request"))
  );
}

function isDependencyPreflightCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.includes("node_modules") ||
    normalized.includes(".venv/bin/") ||
    normalized.includes("venv/bin/") ||
    normalized.includes("vendor/bin/")
  );
}

function configuredExecutionIsolation(
  expectedWorktree: string,
  worktreeIsolation?: LoopWorktreeIsolationMode,
): LoopExecutionIsolation {
  const isolation = defaultExecutionIsolation(expectedWorktree);
  return worktreeIsolation === undefined ? isolation : { ...isolation, worktreeIsolation };
}

export function withLoopExecutionWorktree(
  workOrder: LoopWorkOrder,
  executionWorktree: string,
): LoopWorkOrder {
  const isolation =
    workOrder.executionIsolation ?? defaultExecutionIsolation(workOrder.projectPath);
  return {
    ...workOrder,
    projectPath: executionWorktree,
    executionIsolation: {
      ...isolation,
      expectedWorktree: executionWorktree,
      worktreeIsolation: "isolated",
      sourceWorktree: isolation.sourceWorktree ?? workOrder.projectPath,
      preparedBy: "system-git-worktree",
    },
  };
}

export function withLoopSourceWorktree(workOrder: LoopWorkOrder): LoopWorkOrder {
  const isolation =
    workOrder.executionIsolation ?? defaultExecutionIsolation(workOrder.projectPath);
  return {
    ...workOrder,
    executionIsolation: {
      ...isolation,
      expectedWorktree: workOrder.projectPath,
      worktreeIsolation: "source",
      preparedBy: "source-worktree",
    },
  };
}

export function withLoopWorkspaceRepositoryExecutionWorktrees(
  workOrder: LoopWorkOrder,
  repositories: Array<{
    id: string;
    path: string;
    sourcePath?: string;
    worktreeIsolation?: LoopWorktreeIsolationMode;
  }>,
): LoopWorkOrder {
  if (workOrder.workspace === undefined) return workOrder;
  const replacements = new Map(repositories.map((repository) => [repository.id, repository]));
  return {
    ...workOrder,
    workspace: {
      ...workOrder.workspace,
      repositories: workOrder.workspace.repositories.map((repository) => {
        const replacement = replacements.get(repository.id);
        if (replacement === undefined) return repository;
        return {
          ...repository,
          path: replacement.path,
          ...(replacement.sourcePath !== undefined ? { sourcePath: replacement.sourcePath } : {}),
          ...(replacement.worktreeIsolation !== undefined
            ? { worktreeIsolation: replacement.worktreeIsolation }
            : {}),
        };
      }),
    },
  };
}

function repositoryWorktreeIsolationPolicy(
  repository: LoopWorkspaceConfig["repositories"][number],
  workspace: LoopWorkspaceConfig,
): { worktreeIsolation?: LoopWorktreeIsolationMode } {
  const worktreeIsolation = repository.worktreeIsolation ?? workspace.worktreeIsolation;
  return worktreeIsolation === undefined ? {} : { worktreeIsolation };
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
  const taskPolicy = [
    ...buildLoopWorkspacePolicyLines(workOrder),
    ...buildLoopTaskPolicyLines(workOrder, baseBranch),
  ];
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
    "- Use native agent capabilities inside the worker when useful, including planning, broad exploration, self-review, or native subagents supported by the active agent surface.",
    "- Do not create tmux-claude-bot service roles, queues, leases, or lifecycle state for researcher, planner, evaluator, or subagent work.",
    "- Agentic coding loop: Explore -> Plan -> Code -> Verify -> Review -> Record.",
    "- Explore before editing: inspect relevant code, tests, errors, logs, reports, prior handoff, and system-gate evidence.",
    "- Plan the smallest verifiable slice, including risk, expected behavior, and verification commands before broad or risky edits.",
    "- Code in minimal bounded changes; avoid broad rewrites, unrelated cleanup, and speculative product work.",
    "- Verify with deterministic tests, typecheck, lint, CI, browser/E2E, reproduction commands, or the narrowest available check; do not rely on visual inspection or intuition alone.",
    "- Review behavior, boundaries, regressions, over-engineering, and security risk before finalizing.",
    "- Record what failed or was skipped, and say whether it should become a regression test, eval, monitor, trace, checklist, or doc update.",
    "- For complex, UI/product-experience, PR-review, security, workspace, harness-auto, or long delegated tasks, perform an explicit evaluator-style review pass inside the active worker and record synthesized evidence in reviewGate.evidence; do not create a tmux-claude-bot evaluator service or queue.",
    "- preserve acceptance targets from planning.acceptanceCriteria, task policy, and WorkOrder JSON. Mark targets passed, blocked, or deferred in actionsTaken, reviewGate, planReview, learning, or followUps; do not delete or silently narrow targets to claim completion.",
    "- Capability evals are non-blocking learning signals for behavior the system is still learning to handle. Regression evals are blocking only when they protect behavior already accepted as working and have deterministic or stable agent-backed evidence.",
    "- Do not call model-provider APIs.",
    "- Do not add model SDKs, model API keys, or direct model HTTP integrations.",
    "- Respect allowedActions and blockedActions exactly.",
    "- Preserve unrelated user work and avoid broad rewrites.",
    ...executionIsolationPolicy(workOrder),
    syncPolicy(workOrder, baseBranch),
    "- If the base sync fails, the worktree is dirty, or rebase is impossible, stop and report blocked; do not optimize stale code.",
    commitBranchPolicy(workOrder),
    ghIdentityPolicy,
    ...agentSessionPolicy(workOrder, cli),
    "",
    "Available control commands:",
    `- ${cli} dashboard --json`,
    `- ${cli} sessions`,
    `- ${cli} open <project> --agent <claude|codex>`,
    `- ${cli} open-worker <session> <path> --agent <claude|codex>`,
    `- ${cli} peek <project>`,
    `- ${cli} control <project> compact --yes`,
    `- ${cli} send <project> "<task>"`,
    `- ${cli} send <project> "<long task>" --no-wait, then poll with ${cli} peek <project> until the worker reaches a safe handoff.`,
    `- ${cli} loop run <config> <projectId>`,
    `- ${cli} notify ...`,
    "",
    "Required final response:",
    `- Write the strict JSON final summary to ${shellQuote(finalSummaryPath)} before printing the final marker.`,
    ...finalSummaryContractLines(),
    `- status must be exactly one of: ${SUPERVISOR_FINAL_STATUS_LIST}. Use "completed" for successful no-op runs; do not use "passed", "complete", "done", or "success" as status.`,
    `- Then print ${workOrder.requiredFinalMarker} on its own line. You may print the same strict JSON after it, but the file is authoritative.`,
    ...finalSummaryValidationLines(),
  ].join("\n");
}

function finalSummaryContractLines(): string[] {
  return [
    "- The JSON file must contain fields: status, projectId, actionsTaken, delegatedTasks, finalVerification, reviewGate, commits, followUps. delegatedTasks must be an array of strings, or objects with only projectId and status.",
    "- The JSON file may contain learning with fields: regressionCandidates, capabilityEvalCandidates, monitorOrTraceCandidates, documentationCandidates. learning must classify follow-up candidates without making capability evals blocking acceptance gates.",
    "- If the WorkOrder has planning, include planReview with fields: checklistCompleted, targetScoreMet, stopConditionReached, overOptimizationAvoided, verificationCompleted, remainingRisks.",
    "- reviewGate must be an object with fields: preMutationReview, postMutationReview, aiReview, deterministicGates, decision, notes.",
    "- reviewGate.evidence is optional but required for complex, UI/product-experience, PR-review, security, workspace, harness-auto, or long delegated tasks. Each entry must contain questionInvestigated, conclusion, evidence, uncertainty, recommendedNextStep. Store only synthesized conclusions, not raw subagent transcripts.",
    "- reviewGate.preMutationReview must list the evidence checked before editing, including why the issue or task is real, bounded, allowed, and verifiable; use [] only for read-only/no-op tasks and explain that in notes.",
    "- reviewGate.postMutationReview must list the diff/risk review performed after editing; include regression, security, data, scheduler/state, notification, PR/merge, and switch-back risks when relevant.",
    '- reviewGate.aiReview must be one of "passed", "failed", "not-run", or "not-applicable". It means review through the existing Claude Code / Codex control surface only; do not call model-provider APIs.',
    '- reviewGate.deterministicGates must list the concrete non-AI gates used for final acceptance, such as tests, typecheck, lint, local verification, CI, PR mergeability, clean worktree, switch-back branch, and notification/report artifacts. Prefer objects with name, result, command, and evidence; string entries are also accepted for simple gates. Object result must be one of "passed", "failed", "skipped", or "not-run".',
    '- reviewGate.decision must be "pass", "block", or "fail". Completed code-changing runs require "pass"; use "block" when evidence is incomplete or an external/system condition prevents safe completion.',
  ];
}

function finalSummaryValidationLines(): string[] {
  return [
    '- finalVerification must be one string only: "passed", "failed", "not-run", or "unknown"; put detailed verification notes in actionsTaken, reviewGate, or followUps, not in finalVerification.',
    "- commits must contain only real commit hashes or strings that start with a real commit hash; put PR URLs, PR numbers, and status notes in actionsTaken or followUps.",
    "- AI review is advisory evidence only. Deterministic gates remain authoritative for final acceptance; if AI review and deterministic gates disagree, record the disagreement in reviewGate.notes and do not mark the run completed unless deterministic gates pass.",
    "- Run long or potentially unbounded verification commands with an explicit timeout. If a command exceeds that timeout, stop waiting, record the gate as failed or skipped with concrete evidence in reviewGate.deterministicGates, and report blocked or failed instead of leaving the WorkOrder in flight.",
    "- Use a portable timeout wrapper for bounded shell checks, such as a Node child_process timeout or perl alarm wrapper. Do not assume GNU timeout is installed.",
    "- Before finalizing GitHub PR tasks, inspect PR changes with supported gh commands such as gh pr diff <number> --name-only and gh pr diff <number> --patch; do not rely on unsupported diff-stat flags.",
    "- Before finalizing a PR task, bug-fix task, test-coverage task, security-maintenance task, architecture task, runtime-guardian repair, or daily-audit repair that opened a PR or changed code, re-read the PR body/diff and remove known generated review/release-note blocks such as CodeRabbit auto-generated summaries; the PR body must contain only the intended human-authored summary, verification, and notes.",
  ];
}

function executionIsolationPolicy(workOrder: LoopWorkOrder): string[] {
  const isolation =
    workOrder.executionIsolation ?? defaultExecutionIsolation(workOrder.projectPath);
  if (workOrder.workspace !== undefined) {
    return [
      "Execution isolation:",
      `- This WorkOrder must lease dedicated supervised worker context(s) for run ${workOrder.id}; do not inject this WorkOrder into ordinary user chat or unrelated project sessions.`,
      `- Workspace coordination root: ${workOrder.workspace.root}. Treat it as read-only orchestration context; repository work must happen in the repository-specific expected worktrees below.`,
      ...workspaceWorktreeVerificationPolicy(workOrder),
      `- Reset delegated worker context(s) with ${isolation.contextReset} before substantive task execution and between unrelated subtasks; preserve only the WorkOrder JSON and current verified evidence.`,
      `- Record leased worker/session names, expected worktrees, actual git toplevels, reset actions, and cleanup decisions in actionsTaken or followUps so the run can be replayed from persisted artifacts.`,
      `- On completion, release workers after successful system acceptance; retain workers for ${isolation.cleanup.retainFailureForHours} hour(s) on failure, timeout, cancellation, or invalid output so transcripts can be inspected, then allow cleanup.`,
    ];
  }
  const sourceWorktreeLines =
    isolation.preparedBy === "source-worktree"
      ? [
          "- Worktree mode: source. This is an explicitly configured live/source execution: the dedicated worker session operates in the source worktree so verified self-repair can take effect in the running dev profile. This does not allow using the ordinary human chat session.",
          "- Before editing in source mode, verify the worktree is clean and still on the intended branch; if user changes appear, stop and report blocked.",
        ]
      : isolation.sourceWorktree === undefined
        ? []
        : [
            `- Original project worktree: ${isolation.sourceWorktree}. Do not edit, switch branches, pull, merge, rebase, or commit in this original worktree while executing the WorkOrder; it is reserved for the user's normal session.`,
            "- The worker must use the expected isolated worktree for all assessment, edits, commits, PR inspection, and verification unless a command is explicitly checking that the original worktree stayed clean and on its configured branch.",
          ];
  return [
    "Execution isolation:",
    `- This WorkOrder must lease a dedicated supervised worker context for run ${workOrder.id}; do not inject this WorkOrder into ordinary user chat or an unrelated project session.`,
    `- Expected worktree: ${isolation.expectedWorktree}. Before any sync, assessment, edit, PR review, or shell command that mutates state, run git -C ${shellQuote(isolation.expectedWorktree)} rev-parse --show-toplevel and verify it must equal ${isolation.expectedWorktree}. If it does not match, stop and report blocked.`,
    ...sourceWorktreeLines,
    ...workspaceWorktreeVerificationPolicy(workOrder),
    `- Reset the delegated worker context with ${isolation.contextReset} before substantive task execution and between unrelated subtasks; preserve only the WorkOrder JSON and current verified evidence.`,
    `- Record the leased worker/session name, expected worktree, actual git toplevel, reset action, and cleanup decision in actionsTaken or followUps so the run can be replayed from persisted artifacts.`,
    `- On completion, release the worker after successful system acceptance; retain the worker for ${isolation.cleanup.retainFailureForHours} hour(s) on failure, timeout, cancellation, or invalid output so the transcript can be inspected, then allow cleanup.`,
  ];
}

function workspaceWorktreeVerificationPolicy(workOrder: LoopWorkOrder): string[] {
  if (workOrder.workspace === undefined) return [];
  return workOrder.workspace.repositories.flatMap((repository) => [
    `- For workspace repository ${repository.id}, expected worktree is ${repository.path}. Verify git toplevel is ${repository.path} before touching that repository. Worktree mode: ${repository.worktreeIsolation ?? "auto"}.`,
    ...(repository.worktreeIsolation === "source"
      ? [
          `- Workspace repository ${repository.id} is explicitly using source execution. Keep the dedicated worker context, verify the source worktree is clean before edits, and stop if unrelated user changes appear.`,
        ]
      : []),
    ...(repository.sourcePath === undefined
      ? []
      : [
          `- Original workspace repository ${repository.id}: ${repository.sourcePath}. Do not edit, switch branches, pull, merge, rebase, or commit in this original worktree while executing the WorkOrder; use it only for final clean/switch-back verification.`,
        ]),
  ]);
}

function harnessAutoTask(input: {
  policy: LoopProjectConfig["harnessAuto"];
  architecture: {
    targetScore: number;
    maxRounds: number;
    cleanupPolicy?: LoopCleanupPolicy;
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
  const harnessCleanupPolicy = input.policy.cleanupPolicy ?? "conservative";
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
      cleanupPolicy: input.bugFix.cleanupPolicy ?? harnessCleanupPolicy,
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
      cleanupPolicy: input.securityMaintenance.cleanupPolicy ?? harnessCleanupPolicy,
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
      cleanupPolicy: input.testCoverage.cleanupPolicy ?? harnessCleanupPolicy,
      ...(testCoverage.prompt !== undefined ? { prompt: testCoverage.prompt } : {}),
    },
    {
      kind: "architecture" as const,
      enabled: architectureConfig.enabled,
      weight: architectureConfig.weight,
      targetScore: input.architecture.targetScore,
      maxRounds: input.architecture.maxRounds,
      cleanupPolicy: input.architecture.cleanupPolicy ?? harnessCleanupPolicy,
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
    cleanupPolicy: harnessCleanupPolicy,
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
    cleanupPolicy: policy.cleanupPolicy ?? "conservative",
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
    cleanupPolicy: policy.cleanupPolicy ?? "conservative",
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
    cleanupPolicy: policy.cleanupPolicy ?? "conservative",
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
    mergeMethod: policy.mergeMethod,
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

function automationGovernanceReviewTask(
  policy: LoopProjectConfig["automationGovernanceReview"],
): Extract<LoopWorkOrder["task"], { kind: "automation-governance-review" }> {
  return {
    kind: "automation-governance-review",
    targetScore: policy.targetScore,
    maxFindings: policy.maxFindings,
    allowRepairPr: policy.allowRepairPr,
    requireAiEval: policy.requireAiEval,
    ...(policy.prompt !== undefined ? { prompt: policy.prompt } : {}),
  };
}

function automationGovernancePolicy(
  task: Extract<LoopWorkOrder["task"], { kind: "automation-governance-review" }>,
): NonNullable<LoopWorkOrder["governance"]> {
  return {
    scope: "bot-self-maintenance",
    targetScore: task.targetScore,
    maxFindings: task.maxFindings,
    requireAiEval: task.requireAiEval,
    repair: {
      allowPullRequest: task.allowRepairPr,
      autoMerge: false,
      minimumSeverity: "P1",
      maxPullRequests: 1,
    },
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
    mergeMethod: policy.mergeMethod,
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

function cleanupPolicyForProjectTask(
  project: LoopProjectConfig,
  task: NonNullable<LoopWorkOrder["task"]>,
): LoopCleanupPolicy {
  if (task.kind === "bug-fix") return project.bugFix.cleanupPolicy ?? project.cleanupPolicy;
  if (task.kind === "test-coverage")
    return project.testCoverage.cleanupPolicy ?? project.cleanupPolicy;
  if (task.kind === "security-maintenance")
    return project.securityMaintenance.cleanupPolicy ?? project.cleanupPolicy;
  if (task.kind === "harness-auto")
    return project.harnessAuto.cleanupPolicy ?? project.cleanupPolicy;
  return project.cleanupPolicy;
}

function cleanupPolicyForWorkspaceTask(
  workspace: LoopWorkspaceConfig,
  task: NonNullable<LoopWorkOrder["task"]>,
): LoopCleanupPolicy {
  if (task.kind === "workspace-architecture")
    return workspace.architecture.cleanupPolicy ?? workspace.cleanupPolicy;
  if (task.kind === "bug-fix") return workspace.bugFix.cleanupPolicy ?? workspace.cleanupPolicy;
  if (task.kind === "test-coverage")
    return workspace.testCoverage.cleanupPolicy ?? workspace.cleanupPolicy;
  if (task.kind === "security-maintenance")
    return workspace.securityMaintenance.cleanupPolicy ?? workspace.cleanupPolicy;
  if (task.kind === "harness-auto")
    return workspace.harnessAuto.cleanupPolicy ?? workspace.cleanupPolicy;
  return workspace.cleanupPolicy;
}

function syncPolicy(workOrder: LoopWorkOrder, baseBranch: string): string {
  const isolation = workOrder.executionIsolation;
  if (workOrder.task?.kind === "active-delegated-task") {
    if (workOrder.commitPolicy.enabled && workOrder.pullRequestPolicy?.enabled) {
      return `- Before delegated work, sync the target base branch with target-pinned git commands: ${syncRepositoryCommands(
        workOrder.projectPath,
        baseBranch,
        isolation,
      )}.`;
    }
    return [
      "- Before delegated work, inspect the target repository state from the current branch and preserve the user's active branch context.",
      `- Run ${gitInWorktree(workOrder.projectPath, "status --short")} and record whether unrelated user work is present before editing.`,
      "- Do not switch branches, pull, rebase, merge, or discard local changes unless the user requirement explicitly asks for it or it is necessary and safe to complete the delegated task.",
    ].join("\n");
  }
  if (workOrder.workspace !== undefined) {
    return [
      "- Before assessment or delegated work, sync every workspace repository:",
      ...workOrder.workspace.repositories.map(
        (repository) =>
          `  - ${repository.id}: ${syncRepositoryCommands(
            repository.path,
            repository.pullRequest.switchBack,
            repository.sourcePath === undefined ? undefined : { preparedBy: "system-git-worktree" },
          )}.`,
      ),
    ].join("\n");
  }
  return `- Before assessment or delegated work, sync the target base branch with target-pinned git commands: ${syncRepositoryCommands(
    workOrder.projectPath,
    baseBranch,
    isolation,
  )}.`;
}

function syncRepositoryCommands(
  path: string,
  branch: string,
  isolation?: { preparedBy?: "system-git-worktree" | "source-worktree" },
): string {
  if (isolation?.preparedBy === "system-git-worktree") {
    return [
      `${gitInWorktree(path, "status --short")} must be clean`,
      gitInWorktree(path, `fetch origin ${branch}`),
      gitInWorktree(path, `switch --detach origin/${branch}`),
    ].join(", then ");
  }
  return [
    `${gitInWorktree(path, "status --short")} must be clean`,
    gitInWorktree(path, `fetch origin ${branch}`),
    gitInWorktree(path, `switch ${branch}`),
    gitInWorktree(path, `pull --rebase origin ${branch}`),
  ].join(", then ");
}

function gitInWorktree(path: string, args: string): string {
  return `git -C ${shellQuote(path)} ${args}`;
}

function agentSessionPolicy(workOrder: LoopWorkOrder, cli: string): string[] {
  const task = workOrderTask(workOrder);
  if (workOrder.workspace !== undefined) {
    return [
      "- This workspace task may delegate to multiple isolated loop worker sessions; do not use ordinary user chat sessions.",
      ...workOrder.workspace.repositories.flatMap((repository) => [
        `- Open ${repository.name} in its isolated loop worker: ${openWorkerCommand(
          cli,
          repository.workerSession ?? repository.id,
          repository.path,
          repository.agent,
        )}.`,
        `- After opening ${repository.name}, verify ${cli} dashboard --json shows ${repository.workerSession ?? repository.id} running with the configured agent and path ${repository.path}.`,
      ]),
      contextResetPolicy(workOrder, cli, "<worker-session>"),
    ];
  }
  if (task.kind === "repository-pull-request-review") {
    return [
      "- This repository-wide PR review runs directly from projectPath in this supervisor task; do not call tcb open for the synthetic *-all-prs id.",
      `- Use shell commands from ${shellQuote(workOrder.projectPath)} plus GitHub CLI to inspect, repair, push, and merge PRs.`,
      "- If you need to delegate code editing to a project session, open the real repository path manually; do not require that as a gate for PR review.",
    ];
  }
  const workerSession = workOrder.workerSession ?? workOrder.notificationSession;
  if (workerSession !== undefined) {
    return [
      `- Open the target project in its isolated loop worker: ${openWorkerCommand(
        cli,
        workerSession,
        workOrder.projectPath,
        workOrder.agent,
      )}.`,
      `- Use ${workerSession} for all delegated worker commands: ${cli} peek ${workerSession}, ${cli} control ${workerSession} <action>, and ${cli} send ${workerSession} "<task>" --no-wait for long delegated work. Do not send this WorkOrder to the ordinary user project session.`,
      `- After a no-wait worker delegation, poll ${cli} peek ${workerSession} and repository state until the worker reaches a safe handoff; do not treat the absence of an immediate reply as a failed send.`,
      `- After opening, verify ${cli} dashboard --json shows ${workerSession} running with the configured agent and path ${workOrder.projectPath}; if it does not, stop and report blocked.`,
      contextResetPolicy(workOrder, cli, workerSession),
    ];
  }
  return [
    `- Open the target project with the configured agent: ${cli} open ${shellQuote(workOrder.projectPath)} --agent ${workOrder.agent}.`,
    `- After opening, verify ${cli} dashboard --json shows the target project running with the configured agent; if it does not, stop and report blocked.`,
    `- For long delegated project work, use ${cli} send <project> "<task>" --no-wait, then poll ${cli} peek <project> and repository state until the project reaches a safe handoff; do not treat the absence of an immediate reply as a failed send.`,
    contextResetPolicy(workOrder, cli, "<project>"),
  ];
}

function commitBranchPolicy(workOrder: LoopWorkOrder): string {
  const task = workOrderTask(workOrder);
  if (workOrder.workspace !== undefined) {
    return "- This workspace task uses the repository-scoped branch and PR policy listed above; the top-level workspace commitPolicy is only a container default and must not block repository branches or PRs.";
  }
  if (task.kind === "active-delegated-task") {
    if (workOrder.commitPolicy.enabled && workOrder.commitPolicy.branch !== undefined) {
      return workOrder.executionIsolation?.preparedBy === "system-git-worktree"
        ? `- In the isolated worktree, create or reset the WorkOrder branch from the synced base with git -C ${shellQuote(workOrder.projectPath)} switch -C ${shellQuote(workOrder.commitPolicy.branch)} origin/${baseBranchForWorkOrder(workOrder)}, then use commitPolicy.branch exactly: ${workOrder.commitPolicy.branch}. Do not reuse or merge any other delegated branch.`
        : `- Use the WorkOrder commitPolicy.branch exactly: ${workOrder.commitPolicy.branch}. Do not reuse or merge any other delegated branch.`;
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
    ? workOrder.executionIsolation?.preparedBy === "system-git-worktree"
      ? `- In the isolated worktree, create or reset the WorkOrder branch from the synced base with git -C ${shellQuote(workOrder.projectPath)} switch -C ${shellQuote(workOrder.commitPolicy.branch)} origin/${baseBranchForWorkOrder(workOrder)}, then use commitPolicy.branch exactly: ${workOrder.commitPolicy.branch}. Do not reuse or merge any other loop branch.`
      : `- Use the WorkOrder commitPolicy.branch exactly: ${workOrder.commitPolicy.branch}. Do not reuse or merge any other loop branch.`
    : "- If commits are disabled or no commit branch is configured, do not create a PR branch.";
}

function contextResetPolicy(workOrder: LoopWorkOrder, cli: string, targetRef: string): string {
  const task = workOrderTask(workOrder);
  if (task.kind === "pull-request-review") {
    return `- Run ${cli} control ${targetRef} compact --yes before each delegated review pass.`;
  }
  if (task.kind === "bug-fix") {
    return `- Run ${cli} control ${targetRef} compact --yes before each delegated bug-fix round.`;
  }
  if (task.kind === "test-coverage") {
    return `- Run ${cli} control ${targetRef} compact --yes before each delegated test-coverage round.`;
  }
  if (task.kind === "security-maintenance") {
    return `- Run ${cli} control ${targetRef} compact --yes before each delegated security-maintenance round.`;
  }
  if (task.kind === "harness-auto") {
    return `- Run ${cli} control ${targetRef} compact --yes before each delegated harness-auto round and before switching between different subtask types.`;
  }
  if (task.kind === "active-delegated-task") {
    return `- Run ${cli} control ${targetRef} compact --yes before each delegated task slice when context is stale or before a major verification/review pass.`;
  }
  if (task.kind === "opportunity-discovery") {
    return `- Run ${cli} control ${targetRef} compact --yes before the discovery pass if the target session context is stale.`;
  }
  if (task.kind === "repository-pull-request-review") {
    return `- Run ${cli} control ${targetRef} compact --yes before each delegated repository PR review pass.`;
  }
  return `- Run ${cli} control ${targetRef} compact --yes before each delegated optimization round.`;
}

function openWorkerCommand(
  cli: string,
  workerSession: string,
  projectPath: string,
  agent: LoopProjectConfig["agent"],
): string {
  return `${cli} open-worker ${shellQuote(workerSession)} ${shellQuote(projectPath)} --agent ${agent}`;
}

function githubIdentityPolicy(workOrder: LoopWorkOrder): string {
  const account = workOrder.pullRequestPolicy?.githubAccount;
  if (account === undefined) {
    return "- For GitHub CLI commands, use the repository's normal gh context.";
  }
  const tokenCommand = `GH_TOKEN="$(gh auth token --user ${shellQuote(account)})"`;
  return `- For every GitHub CLI command, use the configured account with a command-local token: ${tokenCommand} gh <api|pr|run|repo> ...; for multi-command shells, first run export ${tokenCommand}. This includes GitHub security findings checks such as gh api; do not rely on the global gh active account.`;
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
  if (
    task.kind === "automation-governance-review" &&
    project.automationGovernanceReview.branch !== undefined
  ) {
    return {
      ...project.commit,
      perRound: false,
      branch: project.automationGovernanceReview.branch,
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
  if (task.kind === "automation-governance-review") {
    return {
      ...project.pullRequest,
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
  return loopRunArtifactPath(projectId, runId, "supervisorFinalSummary");
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
    "- Do not call model-provider APIs.",
    "- Do not add model SDKs, model API keys, or direct model HTTP integrations.",
    "- Do not narrate progress in this response.",
    "",
    "Required final response:",
    `- Write the strict JSON final summary to ${shellQuote(finalSummaryPath)} before printing the final marker.`,
    ...finalSummaryContractLines(),
    `- status must be exactly one of: ${SUPERVISOR_FINAL_STATUS_LIST}. Use "completed" for successful no-op runs; do not use "passed", "complete", "done", or "success" as status.`,
    `- Then print ${workOrder.requiredFinalMarker} on its own line. You may print the same strict JSON after it, but the file is authoritative.`,
    ...finalSummaryValidationLines(),
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
    "- Do not call model-provider APIs.",
    "- Do not add model SDKs, model API keys, or direct model HTTP integrations.",
    "- Do not narrate progress in this response.",
    "",
    "Required final response:",
    `- Write the strict JSON final summary to ${shellQuote(finalSummaryPath)} before printing the final marker.`,
    ...finalSummaryContractLines(),
    `- status must be exactly one of: ${SUPERVISOR_FINAL_STATUS_LIST}. Use "completed" for successful no-op runs; do not use "passed", "complete", "done", or "success" as status.`,
    `- Then print ${input.workOrder.requiredFinalMarker} on its own line. The file is authoritative.`,
    ...finalSummaryValidationLines(),
  ].join("\n");
}
