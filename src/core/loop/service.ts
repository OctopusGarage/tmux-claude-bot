import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import type { HostPowerConfig, WorktreeIsolationMode } from "../../shared/types.js";
import { createWarningCoalescer } from "../../shared/utils/log-coalescer.js";
import { createLogger } from "../../shared/utils/logger.js";
import { paneHasActiveTurn, paneNeedsConfirm } from "../agents/runner-base.js";
import type { AgentKind } from "../agents/types.js";
import { admitAutomationWork } from "../automation/admission.js";
import { observeAgentCapacity } from "../automation/capacity-probe.js";
import { AgentCapacityStore } from "../automation/capacity-store.js";
import {
  type AutonomousAdmissionContext,
  type AutonomousAdmissionLease,
  AutonomousWorkCoordinator,
  type AutonomousWorkIntent,
  autonomousCapacityLeaseId,
} from "../automation/coordinator.js";
import { automationOccurrenceId } from "../automation/occurrence-window.js";
import { agentIsIdle } from "../command/agent-ready.js";
import type { HandlerDeps } from "../deps.js";
import { buildEvalReportFromSupervisorSummary } from "../eval/report.js";
import type { NotificationGateway } from "../notifications/gateway.js";
import { OpportunityStore, parseOpportunityDiscoveryReportFile } from "../opportunities/store.js";
import { formatOpportunityDigest } from "../opportunities/view.js";
import { sessionNameFromPath } from "../projects/sessionPathMap.js";
import { cleanupWorkerSessionRecords } from "../recovery/worker-session-cleanup.js";
import { DailyTaskLedger, type ScheduledTaskRecord } from "../tasks/task-ledger.js";
import {
  createLoopQueueAgentEvalRunner,
  createLoopQueueAgentTaskRunner,
  createLoopSupervisorTaskRunner,
  restoreLoopControlQueue,
} from "./agent-queue.js";
import { LOOP_RUN_ARTIFACTS } from "./artifacts.js";
import { LoopBacklogStore } from "./backlog.js";
import { type LoopProjectConfig, type LoopWorkspaceConfig, parseLoopConfigYaml } from "./config.js";
import {
  cleanupLoopExecutionWorktree,
  isBotOwnedLoopExecutionWorktree,
  type LoopExecutionWorktreePreparationFailure,
  prepareLoopExecutionWorktrees,
} from "./execution-worktree.js";
import { repositoryPullRequestReviewDisposition } from "./final-summary-contract.js";
import {
  recoverInvalidOutputFromFinalSummaryAsync,
  supervisorFinalStatusToRunStatus,
} from "./final-summary-recovery.js";
import { githubCommandForAccount } from "./github-auth.js";
import {
  type LoopPreDispatchAssessment,
  resolveLoopPreDispatchAssessment,
} from "./pre-dispatch-assessment.js";
import {
  createLoopRemoteBranchMaintenance,
  type LoopRemoteBranchMaintenance,
} from "./remote-branch-maintenance.js";
import { writeLoopRunReport } from "./report.js";
import { createRepositoryPullRequestGitHub } from "./repository-pr-github.js";
import {
  createRepositoryPullRequestRecoveryController,
  type RepositoryPullRequestRecoveryController,
} from "./repository-pr-recovery.js";
import { RepositoryPullRequestRecoveryStore } from "./repository-pr-recovery-store.js";
import {
  RepositoryReviewQueue,
  type RepositoryReviewQueueStatus,
} from "./repository-review-queue.js";
import {
  type LoopGitInvocation,
  type LoopRunCommandInvocation,
  type LoopRunCommandResult,
  type LoopRunSummary,
  runLoopProject,
  runLoopProjectAsync,
} from "./run.js";
import { LoopSchedulerStore, runLoopSchedulerTick } from "./scheduler.js";
import {
  type LoopSupervisedRunResult,
  runLoopSupervisedProjectAsync,
  runLoopSupervisorRevisionAsync,
} from "./supervised-runner.js";
import { readActiveLoopSupervisorResources } from "./supervisor-active-resources.js";
import { completeLoopSupervisorRun } from "./supervisor-completion.js";
import { type LoopDueTarget, planLoopSupervisorDispatch } from "./supervisor-dispatch-plan.js";
import { resolveLoopSupervisorDueTarget } from "./supervisor-due-target.js";
import { settleSupervisorWorkOrderOutcome } from "./supervisor-outcome-settlement.js";
import {
  allocateLoopSupervisorBatches,
  type LoopSupervisorResetMode,
  leaseLoopSupervisorWorker,
  readLoopSupervisorWorkerLeaseState,
  releaseLoopSupervisorSessions,
  releaseLoopSupervisorWorker,
  reserveLoopSupervisorSessions,
  writeLoopSupervisorWorkerLeaseState,
} from "./supervisor-pool.js";
import { reconcileTerminalSupervisorResources } from "./supervisor-resource-reconciliation.js";
import { loopSupervisorSessionNames, startLoopSupervisor } from "./supervisor-session.js";
import {
  type LoopSupervisorWorkOrderStateStatus,
  listTerminalLoopSupervisorWorkOrders,
  listUnfinishedLoopSupervisorWorkOrders,
  readLoopSupervisorWorkOrderRegistry,
  workOrderStateForResult,
  writeLoopSupervisorWorkOrderState,
} from "./supervisor-state.js";
import type { LoopTaskSchedulerJobKind } from "./task-family.js";
import type { LoopWorkOrder } from "./work-order.js";
import {
  buildLoopWorkOrder,
  buildLoopWorkspaceWorkOrder,
  buildRepositoryPullRequestReviewWorkOrder,
  parseSupervisorFinalSummaryFile,
} from "./work-order.js";
import type { LoopSupervisorFinalSummary } from "./work-order-contract.js";
import { workerLeaseOutcome } from "./work-order-settlement.js";

const log = createLogger("loop.service");
const logSystemGateFailure = createWarningCoalescer(log, { intervalMs: 5 * 60_000 });
const DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS = 7_200_000;
const DEFAULT_SUPERVISED_PR_CHECK_POLL_ATTEMPTS = 30;
const DEFAULT_SUPERVISED_PR_CHECK_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_SUPERVISOR_REVISION_MAX_ATTEMPTS = 3;
const DEFAULT_GITHUB_PERMISSION_CHECK_ATTEMPTS = 3;
const REPOSITORY_REVIEW_QUEUE_LEASE_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_REVIEW_RETRY_BASE_MS = 15 * 60 * 1000;
const REPOSITORY_REVIEW_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const REPOSITORY_REVIEW_MIN_TICK_MS = 10_000;
const REMOTE_BRANCH_RECONCILIATION_TICK_MS = 30 * 60 * 1000;
const LOG_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const SYSTEM_GATE_GIT_SEARCH_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/run/current-system/sw/bin",
  "/nix/var/nix/profiles/default/bin",
];

function activeCapacityLeaseIdsForWorkOrder(workOrder: LoopWorkOrder): string[] {
  if (workOrder.task?.kind === "active-delegated-task") {
    return [autonomousCapacityLeaseId({ source: "autopilot-delegate", id: workOrder.id })];
  }
  const taskKind = workOrder.task?.kind;
  const ids = [
    `${workOrder.projectId}:${workOrder.scheduledAt}`,
    ...(taskKind === undefined
      ? []
      : [`${workOrder.projectId}:${taskKind}:${workOrder.scheduledAt}`]),
  ];
  if (taskKind === "repository-pull-request-review") {
    ids.push(`pr-review:${workOrder.projectId}:${workOrder.scheduledAt}`);
  }
  return ids.map((id) => autonomousCapacityLeaseId({ source: "loop-engineering", id }));
}

function isLoopWorkOrderCapacityLeaseId(leaseId: string): boolean {
  return (
    leaseId.startsWith("autonomous:loop-engineering:") ||
    leaseId.startsWith("autonomous:autopilot-delegate:")
  );
}

export function reconcileAutonomousCapacityLeases(
  capacityStore: AgentCapacityStore,
  now = Date.now(),
): number {
  const activeByAgent = new Map<AgentKind, Set<string>>([
    ["claude", new Set()],
    ["codex", new Set()],
  ]);
  for (const { workOrder } of readLoopSupervisorWorkOrderRegistry(now).unfinished) {
    const leases = activeByAgent.get(workOrder.agent);
    for (const leaseId of activeCapacityLeaseIdsForWorkOrder(workOrder)) leases?.add(leaseId);
  }
  let removed = 0;
  for (const [agent, activeLeaseIds] of activeByAgent) {
    removed += capacityStore.reconcileActiveLeases(
      agent,
      activeLeaseIds,
      now,
      isLoopWorkOrderCapacityLeaseId,
    );
  }
  return removed;
}

export type SupervisedSystemGateProject = Pick<LoopProjectConfig, "id" | "name" | "path"> & {
  commit: LoopWorkOrder["commitPolicy"];
  pullRequest: NonNullable<LoopWorkOrder["pullRequestPolicy"]>;
};

export type LoopServiceTickSummary = {
  checked: number;
  due: number;
  ran: number;
  failed: number;
};

function logSchedulerTick(input: {
  configFile: string;
  now: number;
  scheduler: ReturnType<typeof runLoopSchedulerTick>;
}): void {
  log.debug("loop engineering scheduler tick", {
    data: {
      configFile: input.configFile,
      cronInterpretation: "utc",
      nowUtc: new Date(input.now).toISOString(),
      nowLocal: formatLogLocalTime(input.now),
      timeZone: LOG_TIME_ZONE,
      checked: input.scheduler.checked,
      scheduled: input.scheduler.scheduled,
      due: input.scheduler.due,
      skipped: input.scheduler.skipped,
      dueProjects: input.scheduler.dueProjects.map((project) => ({
        projectId: project.projectId,
        name: project.name,
        scheduledAtUtc: new Date(project.scheduledAt).toISOString(),
        scheduledAtLocal: formatLogLocalTime(project.scheduledAt),
        effectiveAtUtc: new Date(project.effectiveAt).toISOString(),
        effectiveAtLocal: formatLogLocalTime(project.effectiveAt),
        jitterMs: project.jitterMs,
      })),
    },
  });
}

function formatLogLocalTime(timestamp: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: LOG_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function clearLoopRunTerminalArtifacts(workOrder: {
  finalSummaryPath?: string;
  opportunityReportPath?: string;
}): void {
  if (workOrder.finalSummaryPath === undefined) return;
  const runDir = dirname(workOrder.finalSummaryPath);
  for (const artifact of [
    LOOP_RUN_ARTIFACTS.supervisorFinalSummary,
    LOOP_RUN_ARTIFACTS.supervisorMarkdown,
    LOOP_RUN_ARTIFACTS.systemGate,
  ]) {
    rmSync(join(runDir, artifact), { force: true });
  }
  if (workOrder.opportunityReportPath !== undefined) {
    rmSync(workOrder.opportunityReportPath, { force: true });
  }
}

function logRunResult(input: {
  runId: string;
  scheduledAt: number;
  startedAt: number;
  endedAt: number;
  summary: LoopRunSummary;
  report: ReturnType<typeof writeLoopRunReport>;
}): void {
  const failedCommands = input.summary.commands
    .filter((command) => command.status !== 0)
    .map((command) => ({
      kind: command.kind,
      command: command.command,
      status: command.status,
      stderr: command.stderr.slice(0, 500),
      stdout: command.stdout.slice(0, 500),
    }));
  log[input.summary.status === "passed" ? "info" : "warn"](
    "loop engineering project run complete",
    {
      data: {
        runId: input.runId,
        projectId: input.summary.projectId,
        projectName: input.summary.projectName,
        status: input.summary.status,
        committed: input.summary.committed,
        scheduledAt: new Date(input.scheduledAt).toISOString(),
        startedAt: new Date(input.startedAt).toISOString(),
        endedAt: new Date(input.endedAt).toISOString(),
        durationMs: input.endedAt - input.startedAt,
        rounds: input.summary.rounds.map((round) => ({
          findingId: round.findingId,
          title: round.title,
          status: round.status,
          reason: round.reason,
          commitSha: round.commitSha,
        })),
        failedCommands,
        reportPath: input.report.markdownPath,
        summaryPath: input.report.summaryPath,
      },
    },
  );
}

function shouldRetrySystemSchedule(summary: LoopRunSummary): boolean {
  if (summary.status !== "failed") return false;
  return summary.commands.some((command) => {
    if (command.kind !== "agent") return false;
    const output = `${command.stderr}\n${command.stdout}`;
    return [
      "did not become ready in time",
      "no live project session",
      "failed to start loop project session",
      "task queue is full",
      "duplicate",
      "cancelled before enqueue",
      "task was cancelled",
    ].some((reason) => output.includes(reason));
  });
}

function isGlobalAutomationAdmissionDeferral(reason: string): boolean {
  return [
    "background-closed admission protection is active",
    "heavy-closed admission protection is active",
    "resource pressure",
    "quiet-hours",
    "autonomous-heavy-active-lease",
    "interactive-agent-busy",
    "recent-owner-activity",
    "capacity-exhausted",
    "capacity-state-unavailable",
  ].some((marker) => reason.includes(marker));
}

function logSupervisorRunResult(input: {
  runId: string;
  scheduledAt: number;
  startedAt: number;
  endedAt: number;
  projectId: string;
  projectName: string;
  result: LoopSupervisedRunResult;
  report: ReturnType<typeof completeLoopSupervisorRun>["report"];
  gate: SupervisedSystemGateOutcome;
}): void {
  log[input.result.status === "completed" ? "info" : "warn"](
    "loop engineering supervised project run complete",
    {
      data: {
        runId: input.runId,
        projectId: input.projectId,
        projectName: input.projectName,
        status: input.result.status,
        scheduledAt: new Date(input.scheduledAt).toISOString(),
        startedAt: new Date(input.startedAt).toISOString(),
        endedAt: new Date(input.endedAt).toISOString(),
        durationMs: input.endedAt - input.startedAt,
        gateAccepted: input.gate.failures.length === 0,
        gateEvidence: input.gate.evidence,
        gateFailures: input.gate.failures,
        recoverableGateFailures: supervisorRevisionFailures(input.gate.failures),
        reportPath: input.report.markdownPath,
        summaryPath: input.report.summaryPath,
      },
    },
  );
}

export function runLoopServiceTick(input: {
  configFile: string;
  now: number;
  schedulerStore: LoopSchedulerStore;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  hostPower?: HostPowerConfig;
}): LoopServiceTickSummary {
  const config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
  const scheduler = runLoopSchedulerTick({
    config,
    now: input.now,
    lastFired: input.schedulerStore.getLastFired(),
  });
  logSchedulerTick({ configFile: input.configFile, now: input.now, scheduler });
  let ran = 0;
  let failed = 0;
  const backlog = new LoopBacklogStore();

  for (const due of scheduler.dueProjects) {
    const admission = admitAutomationWork(
      {
        source: "loop-engineering",
        trigger: "background",
        weight: "heavy",
        now: input.now,
      },
      input.hostPower === undefined ? {} : { hostPower: input.hostPower },
    );
    if (!admission.allowed) {
      log.info("loop engineering due target deferred by automation admission", {
        data: {
          projectId: due.projectId,
          jobKey: due.jobKey,
          jobKind: due.jobKind,
          incidentId: admission.incidentId,
          reason: admission.reason,
        },
      });
      if (isGlobalAutomationAdmissionDeferral(admission.reason)) break;
      continue;
    }
    log.info("loop engineering project run start", {
      data: {
        projectId: due.projectId,
        projectName: due.name,
        scheduledAt: new Date(due.scheduledAt).toISOString(),
      },
    });
    const startedAt = Date.now();
    const summary = runLoopProject({
      config,
      projectId: due.projectId,
      runCommand: input.runCommand,
    });
    const endedAt = Date.now();
    const runId = `${due.scheduledAt}-${due.projectId}`;
    const report = writeLoopRunReport(summary, {
      startedAt,
      endedAt,
      runId,
    });
    if (!shouldRetrySystemSchedule(summary)) {
      input.schedulerStore.setLastFired(due.projectId, due.scheduledAt);
    }
    backlog.addSuggestions(summary, endedAt, report.runId);
    logRunResult({ runId, scheduledAt: due.scheduledAt, startedAt, endedAt, summary, report });
    ran++;
    if (summary.status === "failed") failed++;
  }

  return {
    checked: scheduler.checked,
    due: scheduler.due,
    ran,
    failed,
  };
}

export async function runLoopServiceTickAsync(input: {
  configFile: string;
  now: number;
  schedulerStore: LoopSchedulerStore;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentTask?: Parameters<typeof runLoopProjectAsync>[0]["runAgentTask"];
  runAgentEval?: Parameters<typeof runLoopProjectAsync>[0]["runAgentEval"];
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  runSupervisorTask?: Parameters<typeof runLoopSupervisedProjectAsync>[0]["dispatch"];
  supervisorSessionName?: string;
  supervisorSessionNames?: string[];
  notifications?: NotificationGateway;
  projectSessionPrefix?: string;
  resetSupervisorBeforeWorkOrder?: LoopSupervisorResetMode;
  supervisorWorktreeIsolation?: WorktreeIsolationMode;
  ensureSupervisorSession?: (sessionName: string) => Promise<boolean>;
  isSupervisorSessionAvailable?: (sessionName: string) => Promise<boolean>;
  defaultSupervisorTimeoutMs?: number;
  supervisorRevisionMaxAttempts?: number;
  cleanupCompletedWorkerSession?: (sessionName: string) => Promise<void>;
  workerSessionExists?: (sessionName: string) => Promise<boolean>;
  /** Run only the independent repository-review discovery/consumer. */
  repositoryReviewOnly?: boolean;
  /** Keep repository review out of the main Loop tick; production uses the independent consumer. */
  skipRepositoryReview?: boolean;
  hostPower?: HostPowerConfig;
  repositoryPullRequestRecovery?: RepositoryPullRequestRecoveryController;
  automationCoordinator?: AutonomousWorkCoordinator;
  automationAgent?: AgentKind;
  automationContext?: () => AutonomousAdmissionContext;
}): Promise<LoopServiceTickSummary> {
  const config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
  const previousLastFired = input.schedulerStore.getLastFired();
  const scheduler = runLoopSchedulerTick({
    config,
    now: input.now,
    lastFired: previousLastFired,
  });
  logSchedulerTick({ configFile: input.configFile, now: input.now, scheduler });
  let ran = 0;
  let failed = 0;
  const backlog = new LoopBacklogStore();
  const taskLedger = new DailyTaskLedger();
  const repositoryReviewQueue = new RepositoryReviewQueue();
  const repositoryPullRequestRecovery =
    input.repositoryPullRequestRecovery ??
    createRepositoryPullRequestRecoveryController({
      github: createRepositoryPullRequestGitHub({
        run: (command) =>
          input.runCommand({ kind: "pr", command, cwd: dirname(input.configFile), env: {} }),
      }),
      evidence: new RepositoryPullRequestRecoveryStore(),
      verifyTarget: (cwd) => {
        const result = input.runGit?.({ cwd, args: ["rev-parse", "--show-toplevel"] });
        return result?.status === 0 && result.stdout.trim() === cwd;
      },
    });
  const supervisorSessions =
    input.supervisorSessionNames ??
    (input.supervisorSessionName !== undefined ? [input.supervisorSessionName] : []);
  const resetSupervisorBeforeWorkOrder = input.resetSupervisorBeforeWorkOrder ?? "none";
  const maxSupervisorRevisionAttempts =
    input.supervisorRevisionMaxAttempts ?? configuredSupervisorRevisionMaxAttempts();

  type DueProject = (typeof scheduler.dueProjects)[number];
  type ResolvedDue = LoopDueTarget;

  const resolveDue = (due: DueProject): ResolvedDue => {
    return resolveLoopSupervisorDueTarget(config, due);
  };

  const autonomousIntent = (
    target: ResolvedDue,
    includeOccurrence = true,
  ): AutonomousWorkIntent => ({
    id: `${target.due.jobKey}:${target.due.scheduledAt}`,
    source: "loop-engineering",
    trigger: "background",
    weight: "heavy",
    agent: input.automationAgent ?? "claude",
    ...(includeOccurrence
      ? {
          occurrenceId: automationOccurrenceId(
            `${target.due.jobKey}:${target.due.jobKind}`,
            target.due.scheduledAt,
          ),
        }
      : {}),
  });
  const autonomousContext = (): AutonomousAdmissionContext =>
    input.automationContext?.() ??
    (input.hostPower === undefined ? {} : { hostPower: input.hostPower });
  const precheckAutonomousTarget = (
    target: ResolvedDue,
    includeOccurrence = true,
  ): ReturnType<typeof admitAutomationWork> =>
    input.automationCoordinator?.precheck(
      autonomousIntent(target, includeOccurrence),
      autonomousContext(),
    ) ??
    admitAutomationWork(
      {
        source: "loop-engineering",
        trigger: "background",
        weight: "heavy",
        now: input.now,
      },
      input.hostPower === undefined ? {} : { hostPower: input.hostPower },
    );

  const beginLedger = (
    target: ResolvedDue,
    identity?: { startedAt: number; runId: string; ledgerTaskId: string },
  ): { startedAt: number; runId: string; ledgerTaskId: string } => {
    log.info("loop engineering project run start", {
      data: {
        projectId: target.due.projectId,
        projectName: target.due.name,
        jobKey: target.due.jobKey,
        jobKind: target.due.jobKind,
        scheduledAt: new Date(target.due.scheduledAt).toISOString(),
      },
    });
    const startedAt = identity?.startedAt ?? Date.now();
    const runId =
      identity?.runId ??
      runIdForDueProject(
        target.due.scheduledAt,
        target.due.projectId,
        target.due.jobKind,
        target.due.jobKey,
      );
    const ledgerTaskId =
      identity?.ledgerTaskId ?? `loop:${target.due.jobKey}:${target.due.scheduledAt}`;
    taskLedger.expect({
      taskId: ledgerTaskId,
      source: "loop-engineering",
      name: `${target.due.projectId} ${target.due.jobKind}`,
      scheduledAt: target.due.scheduledAt,
    });
    taskLedger.start(ledgerTaskId, startedAt);
    return { startedAt, runId, ledgerTaskId };
  };

  const runSupervisedDue = async (
    target: ResolvedDue,
    supervisorSession: string,
    checkpointScheduler = true,
    admissionLease?: AutonomousAdmissionLease,
  ): Promise<LoopSupervisedRunResult["status"] | "manual-review" | null> => {
    const { due, project, repository, workspace } = target;
    const runner =
      project?.runner ??
      repository?.runner ??
      (workspace !== undefined
        ? workspaceRunnerForJob(workspace, workspaceJobKind(due.jobKind))
        : undefined);
    if (runner?.kind !== "agent-supervised") {
      throw new Error(`loop target "${due.projectId}" is not agent-supervised`);
    }

    let preDispatchAssessment: LoopPreDispatchAssessment | undefined;
    const preDispatch = resolveLoopPreDispatchAssessment({
      target,
      botRoot: process.cwd(),
      runCommand: input.runCommand,
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
      exists: existsSync,
    });
    if (preDispatch.decision !== "run") {
      recordDueTargetWithoutDispatch(target, preDispatch.summary, preDispatch.repairStatus);
      return preDispatch.status;
    }
    preDispatchAssessment = preDispatch.assessment;
    const startedAt = Date.now();
    const runId = runIdForDueProject(
      target.due.scheduledAt,
      target.due.projectId,
      target.due.jobKind,
      target.due.jobKey,
    );
    const ledgerTaskId = `loop:${target.due.jobKey}:${target.due.scheduledAt}`;
    log.info("loop engineering supervised dispatch start", {
      data: {
        runId,
        projectId: due.projectId,
        jobKey: due.jobKey,
        supervisorSession,
        resetBeforeWorkOrder: resetSupervisorBeforeWorkOrder,
      },
    });
    let workOrder =
      repository !== undefined
        ? buildRepositoryPullRequestReviewWorkOrder({
            config,
            repository,
            scheduledAt: due.scheduledAt,
            runId,
          })
        : workspace !== undefined
          ? buildLoopWorkspaceWorkOrder({
              config,
              workspace,
              scheduledAt: due.scheduledAt,
              runId,
              ...(input.projectSessionPrefix !== undefined
                ? { projectSessionPrefix: input.projectSessionPrefix }
                : {}),
              jobKind: workspaceJobKind(due.jobKind),
            })
          : buildLoopWorkOrder({
              config,
              project: requiredProject(project, due.projectId),
              scheduledAt: due.scheduledAt,
              runId,
              ...(input.projectSessionPrefix !== undefined
                ? { projectSessionPrefix: input.projectSessionPrefix }
                : {}),
              jobKind:
                due.jobKind === "pull-request-review"
                  ? "pull-request-review"
                  : due.jobKind === "harness-auto"
                    ? "harness-auto"
                    : due.jobKind === "opportunity-discovery"
                      ? "opportunity-discovery"
                      : due.jobKind === "automation-governance-review"
                        ? "automation-governance-review"
                        : due.jobKind === "test-coverage"
                          ? "test-coverage"
                          : due.jobKind === "security-maintenance"
                            ? "security-maintenance"
                            : due.jobKind === "bug-fix"
                              ? "bug-fix"
                              : "architecture",
            });
    if (preDispatchAssessment !== undefined) {
      workOrder = { ...workOrder, preDispatchAssessment };
    }
    const preparationFailures: LoopExecutionWorktreePreparationFailure[] = [];
    workOrder = prepareLoopExecutionWorktrees({
      workOrder,
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
      defaultMode: input.supervisorWorktreeIsolation ?? "isolated",
      onPreparationFailure: (failure) => preparationFailures.push(failure),
    });
    if (
      preparationFailures.length === 0 &&
      admissionLease !== undefined &&
      input.automationCoordinator !== undefined
    ) {
      const finalAdmission = input.automationCoordinator.revalidate(
        admissionLease,
        autonomousContext(),
      );
      if (!finalAdmission.allowed) {
        if (input.runGit !== undefined && isPreparedIsolatedExecutionWorktree(workOrder)) {
          cleanupLoopExecutionWorktree({
            worktree: workOrder.projectPath,
            runGit: input.runGit,
            ...(workOrder.executionIsolation?.sourceWorktree === undefined
              ? {}
              : { sourceWorktree: workOrder.executionIsolation.sourceWorktree }),
            ...(workOrder.commitPolicy.branch === undefined
              ? {}
              : { expectedBranch: workOrder.commitPolicy.branch }),
          });
        }
        log.info("loop engineering supervised target deferred after preparation", {
          data: {
            projectId: due.projectId,
            jobKey: due.jobKey,
            supervisorSession,
            reason: finalAdmission.reason,
            retryAt: finalAdmission.retryAt,
          },
        });
        return null;
      }
    }
    beginLedger(target, { startedAt, runId, ledgerTaskId });
    if (workOrder.finalSummaryPath !== undefined) {
      mkdirSync(dirname(workOrder.finalSummaryPath), { recursive: true });
    }
    if (workOrder.opportunityReportPath !== undefined) {
      mkdirSync(dirname(workOrder.opportunityReportPath), { recursive: true });
    }
    clearLoopRunTerminalArtifacts(workOrder);
    let supervisorReservationFailure: string | undefined;
    if (preparationFailures.length === 0 && supervisorSession !== "unconfigured-loop-supervisor") {
      const lease = leaseLoopSupervisorWorker({
        state: readLoopSupervisorWorkerLeaseState(),
        supervisorSession,
        workOrder,
        now: Date.now(),
        retainFailureForMs:
          (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000,
      });
      writeLoopSupervisorWorkerLeaseState(lease.state);
      if (lease.status === "unavailable") {
        supervisorReservationFailure = lease.reason;
      }
    }
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession,
      status: "dispatching",
      now: Date.now(),
    });
    const supervisorContextReset =
      due.jobKind === "repository-pull-request-review"
        ? ("clear" as const)
        : resetSupervisorBeforeWorkOrder;
    let result: LoopSupervisedRunResult;
    if (preparationFailures.length > 0) {
      const reason = `execution worktree isolation failed: ${preparationFailures
        .map(
          (failure) =>
            `${failure.repositoryId}: ${failure.reason}${
              failure.detail === undefined ? "" : `: ${failure.detail}`
            } (${failure.sourceWorktree})`,
        )
        .join("; ")}`;
      result = {
        status: "dispatch-failed",
        reason,
        output: reason,
        repairDisposition: preparationFailures.some(
          (failure) => failure.repairDisposition === "target-or-external-blocker",
        )
          ? "target-or-external-blocker"
          : "bot-repairable",
      };
    } else if (supervisorReservationFailure !== undefined) {
      result = {
        status: "dispatch-failed",
        reason: supervisorReservationFailure,
        output: supervisorReservationFailure,
      };
    } else if (supervisorSession === "unconfigured-loop-supervisor") {
      result = {
        status: "dispatch-failed",
        reason: "missing loop supervisor session name",
        output: "missing loop supervisor session name",
      };
    } else if (
      input.ensureSupervisorSession !== undefined &&
      !(await input.ensureSupervisorSession(supervisorSession))
    ) {
      result = {
        status: "dispatch-failed",
        reason: `failed to ensure loop supervisor session "${supervisorSession}"`,
        output: `failed to ensure loop supervisor session "${supervisorSession}"`,
      };
    } else if (input.runSupervisorTask === undefined) {
      result = {
        status: "dispatch-failed",
        reason: "missing loop supervisor dispatch adapter",
        output: "missing loop supervisor dispatch adapter",
      };
    } else {
      result = await runLoopSupervisedProjectAsync({
        workOrder,
        supervisorSession,
        timeoutMs:
          runner.timeoutMs ??
          input.defaultSupervisorTimeoutMs ??
          DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS,
        resetBeforeWorkOrder: supervisorContextReset,
        dispatch: input.runSupervisorTask,
      });
      if (
        isSupervisorDispatchReadinessFailure(result) &&
        input.ensureSupervisorSession !== undefined
      ) {
        log.warn("loop engineering supervised dispatch readiness failed; retrying after ensure", {
          data: {
            runId,
            projectId: due.projectId,
            jobKey: due.jobKey,
            supervisorSession,
            reason: result.reason,
          },
        });
        if (await input.ensureSupervisorSession(supervisorSession)) {
          result = await runLoopSupervisedProjectAsync({
            workOrder,
            supervisorSession,
            timeoutMs:
              runner.timeoutMs ??
              input.defaultSupervisorTimeoutMs ??
              DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS,
            resetBeforeWorkOrder: supervisorContextReset,
            dispatch: input.runSupervisorTask,
          });
        }
      }
    }
    result = await recoverInvalidOutputFromFinalSummaryAsync(workOrder, result);
    let gate = runSupervisedSystemGateOutcome({
      project: systemGateProjectFromWorkOrder(workOrder),
      workOrder,
      result,
      runCommand: input.runCommand,
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    });
    let revisionAttempt = 0;
    let revisionFailures = supervisorRevisionFailures(gate.failures);
    while (
      revisionFailures.length > 0 &&
      revisionAttempt < maxSupervisorRevisionAttempts &&
      input.runSupervisorTask !== undefined
    ) {
      revisionAttempt += 1;
      const revisionStartedAt = Date.now();
      writeLoopSupervisorWorkOrderState({
        workOrder,
        supervisorSession,
        status: "needs-revision",
        now: revisionStartedAt,
        resultStatus: gate.result.status,
        revisionAttempt,
        revisionReasons: revisionFailures,
      });
      log.warn("loop engineering supervised system gate requesting revision", {
        data: {
          runId,
          projectId: due.projectId,
          jobKey: due.jobKey,
          supervisorSession,
          revisionAttempt,
          supervisorRevisionMaxAttempts: maxSupervisorRevisionAttempts,
          failures: revisionFailures,
        },
      });
      result = await runLoopSupervisorRevisionAsync({
        workOrder,
        supervisorSession,
        timeoutMs:
          runner.timeoutMs ??
          input.defaultSupervisorTimeoutMs ??
          DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS,
        dispatch: input.runSupervisorTask,
        failures: revisionFailures,
        attempt: revisionAttempt,
        maxAttempts: maxSupervisorRevisionAttempts,
        previousOutput: gate.result.output,
        resetBeforeWorkOrder: supervisorContextReset,
      });
      result = await recoverInvalidOutputFromFinalSummaryAsync(workOrder, result);
      gate = runSupervisedSystemGateOutcome({
        project: systemGateProjectFromWorkOrder(workOrder),
        workOrder,
        result,
        runCommand: input.runCommand,
        ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
      });
      revisionFailures = supervisorRevisionFailures(gate.failures);
    }
    result = gate.result;
    if (result.status !== "completed") {
      input.automationCoordinator?.recordLimitSignal(
        input.automationAgent ?? "claude",
        result.output,
      );
    }
    let reviewDisposition =
      workOrder.task?.kind === "repository-pull-request-review" && "summary" in result
        ? repositoryPullRequestReviewDisposition(result.summary)
        : workOrder.task?.kind === "repository-pull-request-review"
          ? "invalid"
          : undefined;
    if (
      workOrder.task?.kind === "repository-pull-request-review" &&
      "summary" in result &&
      reviewDisposition !== "completed" &&
      workOrder.pullRequestPolicy?.githubAccount !== undefined
    ) {
      try {
        const recovery = repositoryPullRequestRecovery.recover(result.summary, {
          account: workOrder.pullRequestPolicy.githubAccount,
          cwd: workOrder.projectPath,
          now: Date.now(),
        });
        reviewDisposition = recovery.disposition;
        log.info("repository PR review recovery evaluated", {
          data: {
            workOrderId: workOrder.id,
            repositoryId: workOrder.projectId,
            disposition: recovery.disposition,
            openPullRequests: recovery.openPullRequests,
            repaired: recovery.repaired,
          },
        });
      } catch (error) {
        reviewDisposition = "retry";
        log.warn("repository PR review recovery failed closed", { err: error });
      }
    }
    if (
      workOrder.task?.kind === "repository-pull-request-review" &&
      result.status === "completed" &&
      reviewDisposition !== "completed"
    ) {
      result = {
        ...result,
        status: "blocked",
        summary: {
          ...result.summary,
          status: "blocked",
          finalVerification: "unknown",
        },
      };
    }
    const endedAt = Date.now();
    const completion = completeLoopSupervisorRun({
      workOrder,
      supervisorSession,
      startedAt,
      endedAt,
      result,
      backlog,
    });
    writeSupervisedSystemGateArtifact({
      workOrder,
      report: completion.report,
      gate,
      result,
      writtenAt: endedAt,
    });
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession,
      status: workOrderStateForResult(result),
      now: endedAt,
      resultStatus: result.status,
    });
    const isolatedCleanupFailed =
      result.status === "completed" &&
      input.runGit !== undefined &&
      isPreparedIsolatedExecutionWorktree(workOrder) &&
      !cleanupLoopExecutionWorktree({
        worktree: workOrder.projectPath,
        runGit: input.runGit,
        ...(workOrder.executionIsolation?.sourceWorktree === undefined
          ? {}
          : { sourceWorktree: workOrder.executionIsolation.sourceWorktree }),
        ...(workOrder.commitPolicy.branch === undefined
          ? {}
          : { expectedBranch: workOrder.commitPolicy.branch }),
      });
    settleLoopSupervisorWorkerLease(workOrder, result, endedAt, isolatedCleanupFailed);
    await cleanupCompletedWorkerSession(workOrder, input.cleanupCompletedWorkerSession);
    if (checkpointScheduler) {
      if (completion.retrySchedule || result.status === "invalid-output") {
        restoreLastFired(input.schedulerStore, previousLastFired, due.jobKey, due.scheduledAt);
      } else {
        input.schedulerStore.setLastFired(due.jobKey, due.scheduledAt);
      }
    }
    if (result.status === "completed") {
      taskLedger.finish(ledgerTaskId, {
        endedAt,
        summary: result.summary.actionsTaken.join("; ") || result.status,
        reportPath: completion.report.markdownPath,
      });
      await notifyOpportunityDiscoveryResult({
        workOrder,
        projectPath: target.projectPath,
        cooldownDays:
          project?.opportunityDiscovery.cooldownDays ??
          workspace?.opportunityDiscovery.cooldownDays ??
          14,
        reportPath: completion.report.markdownPath,
        now: endedAt,
        ...(workOrder.notificationSession !== undefined
          ? { notificationSession: workOrder.notificationSession }
          : input.projectSessionPrefix !== undefined
            ? {
                notificationSession: sessionNameFromPath(
                  workOrder.projectPath,
                  input.projectSessionPrefix,
                ),
              }
            : {}),
        ...(input.notifications !== undefined ? { notifications: input.notifications } : {}),
      });
    } else {
      const summary =
        "summary" in result
          ? result.summary.actionsTaken.join("; ") || result.status
          : "Loop supervisor run did not complete successfully.";
      taskLedger.fail(ledgerTaskId, {
        endedAt,
        error: result.status,
        summary,
        reportPath: completion.report.markdownPath,
      });
      if (result.status === "blocked" && gate.failures.length === 0) {
        taskLedger.markRepairStatus(ledgerTaskId, {
          repairStatus: "blocked",
          updatedAt: endedAt,
          summary,
        });
      }
    }
    logSupervisorRunResult({
      runId,
      scheduledAt: due.scheduledAt,
      startedAt,
      endedAt,
      projectId: workOrder.projectId,
      projectName: workOrder.projectName,
      result,
      report: completion.report,
      gate,
    });
    ran++;
    if (result.status !== "completed") failed++;
    if (
      workOrder.task?.kind === "repository-pull-request-review" &&
      result.status === "blocked" &&
      reviewDisposition === "manual-review"
    ) {
      return "manual-review";
    }
    return result.status;
  };

  const runSupervisedDueWithAdmission = async (
    target: ResolvedDue,
    supervisorSession: string,
    checkpointScheduler = true,
    includeOccurrence = true,
  ): Promise<LoopSupervisedRunResult["status"] | "manual-review" | null> => {
    if (input.automationCoordinator === undefined) {
      return runSupervisedDue(target, supervisorSession, checkpointScheduler);
    }
    const result = await input.automationCoordinator.execute(
      autonomousIntent(target, includeOccurrence),
      autonomousContext(),
      (lease) => runSupervisedDue(target, supervisorSession, checkpointScheduler, lease),
      {
        settleOccurrence: (value) =>
          value !== null &&
          input.schedulerStore.getLastFired()[target.due.jobKey] === target.due.scheduledAt,
      },
    );
    if (result.executed) return result.value;
    log.info("loop engineering supervised target deferred by fresh automation admission", {
      data: {
        projectId: target.due.projectId,
        jobKey: target.due.jobKey,
        supervisorSession,
        reason: result.admission.reason,
        retryAt: result.admission.retryAt,
      },
    });
    return null;
  };

  const cleanupCompletedWorkerSession = async (
    workOrder: LoopWorkOrder,
    cleanup: ((sessionName: string) => Promise<void>) | undefined,
  ): Promise<void> => {
    if (workOrder.workerSession === undefined || cleanup === undefined) return;
    try {
      await cleanup(workOrder.workerSession);
      log.info("loop engineering terminal worker session cleaned up", {
        data: {
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          workerSession: workOrder.workerSession,
        },
      });
    } catch (err) {
      log.warn("failed to clean up terminal loop worker session", {
        err,
        data: {
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          workerSession: workOrder.workerSession,
        },
      });
    }
  };

  const runSystemDue = async (target: ResolvedDue): Promise<boolean> => {
    const { due, project } = target;
    const { startedAt, runId, ledgerTaskId } = beginLedger(target);
    const summary = await runLoopProjectAsync({
      config,
      projectId: requiredProject(project, due.projectId).id,
      runCommand: input.runCommand,
      ...(input.runAgentTask !== undefined ? { runAgentTask: input.runAgentTask } : {}),
      ...(input.runAgentEval !== undefined ? { runAgentEval: input.runAgentEval } : {}),
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    });
    const endedAt = Date.now();
    const report = writeLoopRunReport(summary, {
      startedAt,
      endedAt,
      runId,
    });
    const completedOccurrence = !shouldRetrySystemSchedule(summary);
    if (completedOccurrence) {
      input.schedulerStore.setLastFired(due.jobKey, due.scheduledAt);
    }
    if (summary.status === "failed") {
      taskLedger.fail(ledgerTaskId, {
        endedAt,
        error: "loop system run failed",
        summary: summary.commands.map((command) => `${command.kind}:${command.status}`).join(", "),
        reportPath: report.markdownPath,
      });
    } else {
      taskLedger.finish(ledgerTaskId, {
        endedAt,
        summary: summary.status,
        reportPath: report.markdownPath,
      });
    }
    backlog.addSuggestions(summary, endedAt, report.runId);
    logRunResult({ runId, scheduledAt: due.scheduledAt, startedAt, endedAt, summary, report });
    ran++;
    if (summary.status === "failed") failed++;
    return completedOccurrence;
  };

  let supervisedBuffer: ResolvedDue[] = [];
  const flushSupervisedBuffer = async (): Promise<void> => {
    if (supervisedBuffer.length === 0) return;
    const active = activeLoopSupervisorWork(input.configFile);
    const reservedSupervisorSessions = reserveLoopSupervisorSessions(
      supervisorSessions,
      active.supervisorSessions,
    );
    const availableSupervisorSessions =
      supervisorSessions.length === 0 ? supervisorSessions : reservedSupervisorSessions;
    try {
      const idleSupervisorSessions =
        input.isSupervisorSessionAvailable === undefined
          ? availableSupervisorSessions
          : await asyncFilter(availableSupervisorSessions, input.isSupervisorSessionAvailable);
      if (supervisorSessions.length > 0 && idleSupervisorSessions.length === 0) {
        log.warn("loop engineering supervised dispatch skipped because supervisor pool is busy", {
          data: {
            pending: supervisedBuffer.map((target) => ({
              projectId: target.due.projectId,
              jobKey: target.due.jobKey,
              jobKind: target.due.jobKind,
            })),
            activeSupervisorSessions: [...active.supervisorSessions],
            unavailableSupervisorSessions: availableSupervisorSessions.filter(
              (session) => !idleSupervisorSessions.includes(session),
            ),
          },
        });
        supervisedBuffer = [];
        return;
      }
      const plan = planLoopSupervisorDispatch({
        targets: supervisedBuffer,
        activeResourcePaths: active.resourcePaths,
      });
      supervisedBuffer = [];
      for (const skipped of plan.skipped) {
        skipDueTarget(skipped.target, skipped.reason);
      }
      if (plan.deferred.length > 0) {
        log.info("loop engineering supervised targets deferred by conflict planner", {
          data: {
            deferred: plan.deferred.map((deferred) => ({
              projectId: deferred.target.due.projectId,
              jobKey: deferred.target.due.jobKey,
              jobKind: deferred.target.due.jobKind,
              reason: deferred.reason,
              conflictsWith: deferred.conflictsWith,
            })),
          },
        });
      }
      const readyTargets = plan.ready;
      if (readyTargets.length === 0) return;
      const batches = allocateLoopSupervisorBatches(readyTargets, idleSupervisorSessions);
      for (const batch of batches) {
        await Promise.all(
          batch.map(({ item, supervisorSession }) =>
            runSupervisedDueWithAdmission(item, supervisorSession),
          ),
        );
      }
    } finally {
      releaseLoopSupervisorSessions(reservedSupervisorSessions);
    }
  };

  const drainRepositoryReviewQueue = async (): Promise<void> => {
    const tickNow = input.now;
    reconcileRepositoryReviewQueueWorkOrders(
      repositoryReviewQueue,
      tickNow,
      repositoryPullRequestRecovery,
    );
    reconcileRepositoryReviewQueueLedgerClosures(repositoryReviewQueue, taskLedger, tickNow);
    const active = activeLoopSupervisorWork(input.configFile);
    const reservedSupervisorSessions = reserveLoopSupervisorSessions(
      supervisorSessions,
      active.supervisorSessions,
    );
    try {
      const idleSupervisorSessions =
        input.isSupervisorSessionAvailable === undefined
          ? reservedSupervisorSessions
          : await asyncFilter(reservedSupervisorSessions, input.isSupervisorSessionAvailable);
      if (idleSupervisorSessions.length === 0) {
        const readyCount = repositoryReviewQueue.listReady(tickNow).length;
        log.debug("loop engineering repository review queue waiting for supervisor capacity", {
          data: {
            readyCount,
            activeSupervisorSessions: [...active.supervisorSessions],
            reservedSupervisorSessions,
            supervisorSessions,
          },
        });
        return;
      }

      const now = tickNow;
      const queueItems = repositoryReviewQueue.listReady(now, idleSupervisorSessions.length);
      const targets = queueItems.flatMap((item) => {
        const repository = config.prReview.repositories.find(
          (candidate) => candidate.id === item.repositoryId,
        );
        if (repository === undefined) return [];
        return [
          {
            item,
            target: resolveDue({
              projectId: repository.id,
              name: repository.name,
              jobKey: `pr-review:${repository.id}`,
              jobKind: "repository-pull-request-review",
              scheduledAt: item.scheduledAt,
              effectiveAt: item.scheduledAt,
              jitterMs: 0,
              action: "would-run",
            }),
          },
        ];
      });
      const plan = planLoopSupervisorDispatch({
        targets: targets.map(({ target }) => target),
        activeResourcePaths: active.resourcePaths,
      });
      if (plan.ready.length === 0) {
        log.debug("loop engineering repository review queue deferred by resource planner", {
          data: {
            queueItems: queueItems.map((item) => ({
              id: item.id,
              repositoryId: item.repositoryId,
              status: item.status,
            })),
            deferred: plan.deferred.map((item) => ({
              projectId: item.target.due.projectId,
              reason: item.reason,
              conflictsWith: item.conflictsWith,
            })),
          },
        });
        return;
      }
      const targetByKey = new Map(
        targets.map(({ item, target }) => [`${target.due.projectId}:${item.scheduledAt}`, item]),
      );
      const batches = allocateLoopSupervisorBatches(plan.ready, idleSupervisorSessions);
      for (const batch of batches) {
        await Promise.all(
          batch.map(async ({ item: target, supervisorSession }) => {
            const queueItem = targetByKey.get(`${target.due.projectId}:${target.due.scheduledAt}`);
            if (queueItem === undefined) return;
            const admission = precheckAutonomousTarget(target, false);
            if (!admission.allowed) {
              log.info("loop engineering repository review deferred by automation admission", {
                data: {
                  jobKey: target.due.jobKey,
                  queueItemId: queueItem.id,
                  incidentId: admission.incidentId,
                  reason: admission.reason,
                },
              });
              return;
            }
            const owner = `${process.pid}:${supervisorSession}`;
            const leased = repositoryReviewQueue.lease(
              queueItem.id,
              owner,
              now,
              REPOSITORY_REVIEW_QUEUE_LEASE_MS,
            );
            if (leased === null) return;
            repositoryReviewQueue.markRunning(leased.id, owner, tickNow);
            try {
              const admitted = await runSupervisedDueWithAdmission(
                target,
                supervisorSession,
                false,
                false,
              );
              if (admitted === null) {
                repositoryReviewQueue.retry(
                  leased.id,
                  owner,
                  tickNow,
                  "automation admission changed before dispatch",
                  tickNow + REPOSITORY_REVIEW_RETRY_BASE_MS,
                );
                return;
              }
              const result = admitted;
              if (result === "completed") {
                repositoryReviewQueue.complete(leased.id, owner, tickNow, "completed");
              } else if (result === "manual-review") {
                repositoryReviewQueue.manualReview(
                  leased.id,
                  owner,
                  tickNow,
                  "repository review recorded an explicit manual decision",
                );
              } else if (result === "blocked") {
                const retryDelay = Math.min(
                  REPOSITORY_REVIEW_RETRY_MAX_MS,
                  REPOSITORY_REVIEW_RETRY_BASE_MS * 2 ** Math.max(0, leased.attempt - 1),
                );
                repositoryReviewQueue.retry(
                  leased.id,
                  owner,
                  tickNow,
                  "repository review has retryable or incomplete decisions",
                  tickNow + retryDelay,
                );
              } else {
                const retryDelay = Math.min(
                  REPOSITORY_REVIEW_RETRY_MAX_MS,
                  REPOSITORY_REVIEW_RETRY_BASE_MS * 2 ** Math.max(0, leased.attempt - 1),
                );
                repositoryReviewQueue.fail(
                  leased.id,
                  owner,
                  tickNow,
                  `repository review supervisor result: ${result}`,
                  tickNow + retryDelay,
                );
              }
            } catch (err) {
              const retryDelay = Math.min(
                REPOSITORY_REVIEW_RETRY_MAX_MS,
                REPOSITORY_REVIEW_RETRY_BASE_MS * 2 ** Math.max(0, leased.attempt - 1),
              );
              repositoryReviewQueue.fail(
                leased.id,
                owner,
                tickNow,
                err instanceof Error ? err.message : String(err),
                tickNow + retryDelay,
              );
            }
          }),
        );
      }
    } finally {
      releaseLoopSupervisorSessions(reservedSupervisorSessions);
    }
  };

  const recordDueTargetWithoutDispatch = (
    target: ResolvedDue,
    summary: string,
    repairStatus: "not-needed" | "blocked",
  ): void => {
    const endedAt = Date.now();
    const taskId = `loop:${target.due.jobKey}:${target.due.scheduledAt}`;
    taskLedger.expect({
      taskId,
      source: "loop-engineering",
      name: `${target.due.projectId} ${target.due.jobKind}`,
      scheduledAt: target.due.scheduledAt,
    });
    if (repairStatus === "not-needed") {
      taskLedger.skip(taskId, { endedAt, summary });
    } else {
      taskLedger.fail(taskId, { endedAt, error: summary, summary });
      taskLedger.markRepairStatus(taskId, { repairStatus, updatedAt: endedAt, summary });
    }
    input.schedulerStore.setLastFired(target.due.jobKey, target.due.scheduledAt);
    log.info("loop engineering due target completed without supervisor dispatch", {
      data: {
        projectId: target.due.projectId,
        jobKey: target.due.jobKey,
        jobKind: target.due.jobKind,
        scheduledAt: new Date(target.due.scheduledAt).toISOString(),
        summary,
        repairStatus,
      },
    });
  };

  const skipDueTarget = (target: ResolvedDue, summary: string): void =>
    recordDueTargetWithoutDispatch(target, summary, "not-needed");

  const admittedRepositoryReviewDues: DueProject[] = [];
  for (const due of scheduler.dueProjects) {
    const isRepositoryReview = due.jobKind === "repository-pull-request-review";
    if (input.repositoryReviewOnly && !isRepositoryReview) continue;
    if (!input.repositoryReviewOnly && input.skipRepositoryReview && isRepositoryReview) continue;
    const target = resolveDue(due);
    const admission = precheckAutonomousTarget(target);
    if (!admission.allowed) {
      log.info("loop engineering due target deferred by automation admission", {
        data: {
          projectId: due.projectId,
          jobKey: due.jobKey,
          jobKind: due.jobKind,
          incidentId: admission.incidentId,
          reason: admission.reason,
        },
      });
      if (isGlobalAutomationAdmissionDeferral(admission.reason)) break;
      continue;
    }
    if (input.repositoryReviewOnly) {
      admittedRepositoryReviewDues.push(due);
      continue;
    }
    const runner = target.project?.runner ?? target.repository?.runner ?? target.workspace?.runner;
    if (runner?.kind === "agent-supervised") {
      supervisedBuffer.push(target);
      continue;
    }
    await flushSupervisedBuffer();
    if (input.automationCoordinator === undefined) {
      await runSystemDue(target);
    } else {
      const result = await input.automationCoordinator.execute(
        autonomousIntent(target),
        autonomousContext(),
        () => runSystemDue(target),
        { settleOccurrence: (completed) => completed },
      );
      if (!result.executed) {
        log.info("loop engineering system target deferred by fresh automation admission", {
          data: {
            projectId: due.projectId,
            jobKey: due.jobKey,
            reason: result.admission.reason,
            retryAt: result.admission.retryAt,
          },
        });
      }
    }
  }
  if (!input.repositoryReviewOnly) {
    await flushSupervisedBuffer();
  } else {
    for (const due of admittedRepositoryReviewDues) {
      repositoryReviewQueue.enqueue({
        repositoryId: due.projectId,
        scheduledAt: due.scheduledAt,
        priority: 1000,
        now: input.now,
      });
      input.schedulerStore.setLastFired(due.jobKey, due.scheduledAt);
      input.automationCoordinator?.settleOccurrence(
        automationOccurrenceId(`${due.jobKey}:${due.jobKind}`, due.scheduledAt),
      );
    }
    await drainRepositoryReviewQueue();
  }

  return {
    checked: scheduler.checked,
    due: scheduler.due,
    ran,
    failed,
  };
}

async function notifyOpportunityDiscoveryResult(input: {
  workOrder: LoopWorkOrder;
  projectPath: string;
  cooldownDays: number;
  reportPath: string;
  notifications?: NotificationGateway;
  notificationSession?: string;
  now: number;
}): Promise<void> {
  if (input.workOrder.task?.kind !== "opportunity-discovery") return;
  const report = parseOpportunityDiscoveryReportFile(input.workOrder.opportunityReportPath);
  if (report === null) {
    log.warn("loop opportunity discovery completed without a valid opportunity report", {
      data: {
        projectId: input.workOrder.projectId,
        runId: input.workOrder.id,
        opportunityReportPath: input.workOrder.opportunityReportPath,
      },
    });
    return;
  }
  const suggestions = new OpportunityStore().upsertDiscoveryReport({
    report,
    projectPath: input.projectPath,
    runId: input.workOrder.id,
    cooldownDays: input.cooldownDays,
    now: input.now,
  });
  if (suggestions.length === 0) {
    log.info("loop opportunity discovery produced no new suggestions after cooldown filtering", {
      data: {
        projectId: input.workOrder.projectId,
        runId: input.workOrder.id,
        opportunityReportPath: input.workOrder.opportunityReportPath,
      },
    });
    return;
  }
  const suggestionIds = suggestions.map((suggestion) => suggestion.id);
  log.info("loop opportunity discovery suggestions stored", {
    data: {
      projectId: input.workOrder.projectId,
      runId: input.workOrder.id,
      suggestionCount: suggestions.length,
      suggestionIds,
      opportunityReportPath: input.workOrder.opportunityReportPath,
      reportPath: input.reportPath,
      notificationChannel: input.workOrder.task.notificationChannel ?? "registered",
      notificationSession: input.notificationSession,
    },
  });
  const body = formatOpportunityDigest({
    projectId: input.workOrder.projectId,
    projectName: input.workOrder.projectName,
    suggestions,
    reportPath: input.reportPath,
  });
  if (input.notifications === undefined) {
    log.warn("loop opportunity discovery notification skipped because no gateway is configured", {
      data: {
        projectId: input.workOrder.projectId,
        runId: input.workOrder.id,
        suggestionCount: suggestions.length,
        suggestionIds,
        notificationSession: input.notificationSession,
      },
    });
    return;
  }
  const result = await input.notifications.notify({
    ...(input.workOrder.task.notificationChannel !== undefined
      ? { channel: input.workOrder.task.notificationChannel }
      : {}),
    ...(input.notificationSession !== undefined ? { session: input.notificationSession } : {}),
    source: "opportunity-discovery",
    level: "info",
    title: `Opportunity suggestions: ${input.workOrder.projectName}`,
    body,
    opportunities: suggestions.map((suggestion) => ({
      id: suggestion.id,
      title: suggestion.title,
      projectName: suggestion.projectName,
      category: suggestion.category,
      confidence: suggestion.confidence,
      estimatedComplexity: suggestion.estimatedComplexity,
      status: suggestion.status,
      value: suggestion.value,
      problem: suggestion.problem,
      recommendedApproach: suggestion.recommendedApproach,
    })),
  });
  log.info("loop opportunity discovery notification result", {
    data: {
      projectId: input.workOrder.projectId,
      runId: input.workOrder.id,
      requestedChannel: input.workOrder.task.notificationChannel ?? "registered",
      notificationSession: input.notificationSession,
      registeredChannels: input.notifications.registeredChannels(),
      status: result.status,
      deliveries: result.deliveries,
      suggestionCount: suggestions.length,
      suggestionIds,
    },
  });
}

async function asyncFilter<T>(
  values: readonly T[],
  predicate: (value: T) => Promise<boolean>,
): Promise<T[]> {
  const decisions = await Promise.all(values.map((value) => predicate(value)));
  return values.filter((_, index) => decisions[index]);
}

function activeLoopSupervisorWork(configFile: string): {
  supervisorSessions: Set<string>;
  projectPaths: Set<string>;
  resourcePaths: Set<string>;
} {
  const { supervisorSessions, projectPaths, resourcePaths } = readActiveLoopSupervisorResources();
  if (supervisorSessions.size > 0) {
    log.debug("loop engineering active supervisor work detected", {
      data: {
        configFile,
        activeSupervisorSessions: [...supervisorSessions],
        activeProjectPaths: [...projectPaths],
        activeResourcePaths: [...resourcePaths],
      },
    });
  }
  return { supervisorSessions, projectPaths, resourcePaths };
}

function requiredProject(
  project: LoopProjectConfig | undefined,
  projectId: string,
): LoopProjectConfig {
  if (project === undefined)
    throw new Error(`loop scheduler produced unknown project "${projectId}"`);
  return project;
}

function restoreLastFired(
  store: LoopSchedulerStore,
  previousLastFired: Record<string, number>,
  jobKey: string,
  failedScheduledAt: number,
): void {
  const current = store.getLastFired()[jobKey];
  if (current !== failedScheduledAt) return;
  const previous = previousLastFired[jobKey];
  if (previous === undefined) store.clearLastFired(jobKey);
  else store.setLastFired(jobKey, previous);
}

export function reconcileRepositoryReviewQueueLedgerClosures(
  queue: RepositoryReviewQueue,
  ledger: DailyTaskLedger,
  now: number,
): number {
  let reconciled = 0;
  const recordsByTaskId = new Map(ledger.listAll().map((record) => [record.taskId, record]));

  for (const item of queue.list({ all: true })) {
    if (isTerminalRepositoryReviewQueueStatus(item.status)) continue;
    const taskId = `loop:pr-review:${item.repositoryId}:${item.scheduledAt}`;
    const record = recordsByTaskId.get(taskId);
    if (record === undefined) continue;
    const closure = repositoryReviewQueueClosureFromLedger(record);
    if (closure === null) continue;
    if (
      queue.completeOccurrence(
        item.repositoryId,
        item.scheduledAt,
        now,
        closure.status,
        closure.reason,
      )
    ) {
      reconciled++;
    }
  }

  return reconciled;
}

function repositoryReviewQueueClosureFromLedger(
  record: ScheduledTaskRecord,
): { status: "completed" | "blocked"; reason: string } | null {
  if (record.source !== "loop-engineering") return null;
  if (!record.taskId.startsWith("loop:pr-review:")) return null;
  if (
    record.status === "success" ||
    record.status === "skipped" ||
    record.repairStatus === "completed" ||
    record.repairStatus === "fixed" ||
    record.repairStatus === "not-needed" ||
    record.repairStatus === "superseded" ||
    record.repairStatus === "not-reproducible"
  ) {
    return {
      status: "completed",
      reason: `reconciled from daily task ledger repairStatus=${record.repairStatus ?? "not-needed"}`,
    };
  }
  if (record.repairStatus === "blocked") {
    return {
      status: "blocked",
      reason: "reconciled from daily task ledger repairStatus=blocked",
    };
  }
  return null;
}

function isTerminalRepositoryReviewQueueStatus(status: RepositoryReviewQueueStatus): boolean {
  return (
    status === "completed" ||
    status === "blocked" ||
    status === "manual-review" ||
    status === "dead-letter"
  );
}

/* c8 ignore start -- filesystem-backed WorkOrder reconciliation is exercised by live service smoke tests. */
function reconcileRepositoryReviewQueueWorkOrders(
  queue: RepositoryReviewQueue,
  now: number,
  recovery: RepositoryPullRequestRecoveryController,
): void {
  for (const record of listUnfinishedLoopSupervisorWorkOrders()) {
    if (record.workOrder.task?.kind !== "repository-pull-request-review") continue;
    const hasActiveWorkerLease = readLoopSupervisorWorkerLeaseState().leases.some(
      (lease) =>
        lease.status === "active" &&
        lease.workOrderId === record.workOrder.id &&
        lease.workerSession === record.state.supervisorSession,
    );
    const adopted = queue.adoptRunning(
      record.workOrder.projectId,
      record.workOrder.scheduledAt,
      `${process.pid}:${record.state.supervisorSession}`,
      now,
      REPOSITORY_REVIEW_QUEUE_LEASE_MS,
      hasActiveWorkerLease,
    );
    if (adopted === null) continue;
    log.info("loop engineering repository review queue adopted active work order", {
      data: {
        workOrderId: record.workOrder.id,
        repositoryId: record.workOrder.projectId,
        queueItemId: adopted.id,
        supervisorSession: record.state.supervisorSession,
        status: adopted.status,
      },
    });
  }
  for (const record of listTerminalLoopSupervisorWorkOrders()) {
    if (record.workOrder.task?.kind !== "repository-pull-request-review") continue;
    const resultStatus =
      record.state.resultStatus ?? terminalStateToResultStatus(record.state.status);
    const queueItem = queue
      .list({ all: true })
      .find(
        (item) =>
          item.repositoryId === record.workOrder.projectId &&
          item.scheduledAt === record.workOrder.scheduledAt,
      );
    if (
      queueItem !== undefined &&
      queue.canRecoverTerminal(queueItem.id) &&
      (queueItem.status === "manual-review" || queueItem.status === "dead-letter") &&
      record.workOrder.pullRequestPolicy?.githubAccount !== undefined
    ) {
      const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
      if (parsed.ok && repositoryPullRequestReviewDisposition(parsed.summary) === "retry") {
        try {
          const recovered = recovery.recover(parsed.summary, {
            account: record.workOrder.pullRequestPolicy.githubAccount,
            cwd: record.workOrder.projectPath,
            now,
          });
          if (recovered.disposition === "retry" && recovered.openPullRequests > 0) {
            queue.reopenTerminal(queueItem.id, {
              now,
              reason: "migrated false repository review terminal after structured revalidation",
            });
          } else if (recovered.disposition === "completed" && recovered.openPullRequests === 0) {
            queue.completeRecoveredTerminal(queueItem.id, {
              now,
              reason: "revalidated repository review pull requests are already terminal",
            });
          }
        } catch (error) {
          log.warn("repository PR review terminal migration failed closed", { err: error });
        }
      }
    }
    const retryDelay =
      queueItem === undefined
        ? REPOSITORY_REVIEW_RETRY_BASE_MS
        : Math.min(
            REPOSITORY_REVIEW_RETRY_MAX_MS,
            REPOSITORY_REVIEW_RETRY_BASE_MS * 2 ** Math.max(0, queueItem.attempt - 1),
          );
    const settled =
      resultStatus === "completed"
        ? queue.completeOccurrence(
            record.workOrder.projectId,
            record.workOrder.scheduledAt,
            now,
            "completed",
          )
        : queue.retryOccurrence(
            record.workOrder.projectId,
            record.workOrder.scheduledAt,
            now,
            `recovered supervisor work order result: ${resultStatus}`,
            now + retryDelay,
          );
    if (!settled) continue;
    log.info("loop engineering repository review queue reconciled terminal work order", {
      data: {
        workOrderId: record.workOrder.id,
        repositoryId: record.workOrder.projectId,
        resultStatus,
      },
    });
  }
}
/* c8 ignore stop */

export async function startLoopEngineering(
  deps: HandlerDeps,
  config: { configFile: string; tickMs: number },
  options: { remoteBranchMaintenance?: LoopRemoteBranchMaintenance } = {},
): Promise<() => void> {
  if (config.configFile.trim() === "" || config.tickMs === 0) return () => {};
  log.info("loop engineering supervisor pool configured", {
    data: {
      enabled: deps.config.loopEngineering.supervisor.enabled,
      poolSize: deps.config.loopEngineering.supervisor.poolSize,
      resetBeforeWorkOrder: deps.config.loopEngineering.supervisor.resetBeforeWorkOrder,
      supervisorSessions: loopSupervisorSessionNames(
        deps.config.projectSessionPrefix,
        deps.config.loopEngineering.supervisor.poolSize,
      ),
      timeZone: LOG_TIME_ZONE,
      cronInterpretation: "utc",
    },
  });
  const recoveredRevisionDispatch = createLoopSupervisorTaskRunner(deps);
  const runRecoveredSupervisorRevision = deps.config.loopEngineering.supervisor.enabled
    ? async (input: {
        workOrder: LoopWorkOrder;
        supervisorSession: string;
        failures: string[];
        attempt: number;
        maxAttempts: number;
        previousOutput: string;
      }): Promise<LoopSupervisedRunResult> => {
        await startLoopSupervisor(deps, undefined, input.supervisorSession);
        return runLoopSupervisorRevisionAsync({
          ...input,
          timeoutMs:
            (input.workOrder.runner.kind === "agent-supervised"
              ? input.workOrder.runner.timeoutMs
              : undefined) ?? deps.config.maxWaitDoneTotalMs,
          dispatch: recoveredRevisionDispatch,
          resetBeforeWorkOrder: deps.config.loopEngineering.supervisor.resetBeforeWorkOrder,
        });
      }
    : undefined;
  // Reconcile durable completion evidence before restoring queued prompts. A
  // restored prompt may otherwise replay work whose worker finished immediately
  // before the previous process stopped.
  const startupReconciliation = await reconcileLoopSupervisorWorkOrders({
    configFile: config.configFile,
    now: Date.now(),
    runCommand: runShellCommand,
    runGit: runGitCommand,
    ...(runRecoveredSupervisorRevision === undefined
      ? {}
      : { runSupervisorRevision: runRecoveredSupervisorRevision }),
    cleanupCompletedWorkerSession: async (sessionName) => {
      await deps.bridge.killSession(sessionName);
      cleanupWorkerSessionRecords(sessionName);
    },
    workerSessionExists: (sessionName) => deps.bridge.hasSession(sessionName),
    workerSessionOwnsActiveTurn: (probe) =>
      supervisorWorkerSessionOwnsActiveTurn(deps, probe.workerSession, probe.workOrder.agent),
  });
  if (startupReconciliation.checked > 0) {
    log.info("loop engineering supervisor work order reconcile complete", {
      data: startupReconciliation,
    });
  }
  const restored = restoreLoopControlQueue({ queue: deps.queue });
  if (restored > 0) log.info("loop engineering control queue restored", { data: { restored } });
  const schedulerStore = new LoopSchedulerStore();
  const capacityStore = new AgentCapacityStore();
  const reconcileCapacityLeases = (): void => {
    const released = reconcileAutonomousCapacityLeases(capacityStore, Date.now());
    if (released > 0) {
      log.info("loop engineering stale autonomous capacity leases released", {
        data: { released },
      });
    }
  };
  reconcileCapacityLeases();
  const automationCoordinator = new AutonomousWorkCoordinator({
    capacity: capacityStore,
    onCapacityTransition: (transition) =>
      deps.notifications.notify({
        source: "loop-engineering",
        level: transition.to === "available" ? "info" : "warning",
        title:
          transition.to === "exhausted"
            ? `${transition.agent} capacity exhausted`
            : transition.to === "available"
              ? `${transition.agent} capacity recovered`
              : `${transition.agent} capacity ${transition.to}`,
        body: [
          `Capacity changed from ${transition.from} to ${transition.to}.`,
          `Reason: ${transition.reason}`,
          ...(transition.resetAt === null
            ? []
            : [`Next probe: ${new Date(transition.resetAt).toISOString()}`]),
        ].join("\n"),
        delivery: {
          mode: "state-change",
          topic: `agent-capacity:${transition.agent}`,
          state: transition.to,
          ...(transition.to === "available" ? { notifyInitial: false } : {}),
        },
      }),
  });
  const automationAgent = deps.config.loopEngineering.supervisor.agent;
  const supervisorSessions = loopSupervisorSessionNames(
    deps.config.projectSessionPrefix,
    deps.config.loopEngineering.supervisor.poolSize,
  );
  let capacityRefresh: Promise<void> | null = null;
  const refreshCapacity = async (): Promise<void> => {
    const now = Date.now();
    const current = capacityStore.read(automationAgent, now);
    if (current.observedAt > 0 && current.nextProbeAt > now) return;
    if (capacityRefresh !== null) return capacityRefresh;
    capacityRefresh = (async () => {
      const session = supervisorSessions[0];
      if (session === undefined) {
        capacityStore.ensureUnknown(automationAgent, now);
        return;
      }
      const observation = await observeAgentCapacity({
        agent: automationAgent,
        session,
        projectPath: dirname(config.configFile),
        resolver: deps.configResolver,
        now,
      });
      automationCoordinator.recordCapacityObservation(observation, "loop-engineering");
    })().finally(() => {
      capacityRefresh = null;
    });
    return capacityRefresh;
  };
  const automationContext = (): AutonomousAdmissionContext => ({
    hostPower: deps.config.hostPower,
    ownerLastActivityAt: deps.ownerActivity.lastObservedAt(),
    interactiveBusy: ownerInteractiveWorkBusy(deps),
  });
  const remoteBranchMaintenance =
    options.remoteBranchMaintenance ??
    createLoopRemoteBranchMaintenance({
      configFile: config.configFile,
      runCommand: runShellCommand,
      runGit: runGitCommand,
    });
  let remoteBranchReconciliationInFlight = false;
  const reconcileRemoteBranches = async (): Promise<void> => {
    if (remoteBranchReconciliationInFlight) return;
    remoteBranchReconciliationInFlight = true;
    try {
      const result = await remoteBranchMaintenance.reconcile(Date.now());
      if (result.scanned > 0 || result.failed > 0) {
        log.info("loop remote branch reconciliation complete", { data: result });
      }
    } catch (err) {
      log.warn("loop remote branch reconciliation failed closed", { err });
    } finally {
      remoteBranchReconciliationInFlight = false;
    }
  };
  void reconcileRemoteBranches();
  let tickInFlight = false;
  let repositoryReviewTickInFlight = false;
  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      log.warn("loop engineering tick skipped because previous tick is still running");
      return;
    }
    tickInFlight = true;
    try {
      const reconciled = await reconcileLoopSupervisorWorkOrders({
        configFile: config.configFile,
        now: Date.now(),
        runCommand: runShellCommand,
        runGit: runGitCommand,
        ...(runRecoveredSupervisorRevision === undefined
          ? {}
          : { runSupervisorRevision: runRecoveredSupervisorRevision }),
        cleanupCompletedWorkerSession: async (sessionName) => {
          await deps.bridge.killSession(sessionName);
          cleanupWorkerSessionRecords(sessionName);
        },
        workerSessionExists: (sessionName) => deps.bridge.hasSession(sessionName),
        workerSessionOwnsActiveTurn: (probe) =>
          supervisorWorkerSessionOwnsActiveTurn(deps, probe.workerSession, probe.workOrder.agent),
        supervisorSessionBusy: (sessionName) => supervisorSessionHasQueuedWork(deps, sessionName),
      });
      if (reconciled.checked > 0) {
        log.info("loop engineering supervisor work order reconcile complete", { data: reconciled });
      }
      reconcileCapacityLeases();
      await refreshCapacity();
      const result = await runLoopServiceTickAsync({
        configFile: config.configFile,
        now: Date.now(),
        schedulerStore,
        runCommand: runShellCommand,
        runAgentTask: createLoopQueueAgentTaskRunner(deps),
        runAgentEval: createLoopQueueAgentEvalRunner(deps),
        runGit: runGitCommand,
        runSupervisorTask: createLoopSupervisorTaskRunner(deps),
        cleanupCompletedWorkerSession: async (sessionName) => {
          await deps.bridge.killSession(sessionName);
          cleanupWorkerSessionRecords(sessionName);
        },
        workerSessionExists: (sessionName) => deps.bridge.hasSession(sessionName),
        supervisorSessionNames: supervisorSessions,
        resetSupervisorBeforeWorkOrder: deps.config.loopEngineering.supervisor.resetBeforeWorkOrder,
        supervisorWorktreeIsolation: deps.config.loopEngineering.supervisor.worktreeIsolation,
        ...(deps.config.loopEngineering.supervisor.enabled
          ? {
              ensureSupervisorSession: async (sessionName) =>
                startLoopSupervisor(deps, undefined, sessionName),
              isSupervisorSessionAvailable: async (sessionName) =>
                supervisorSessionIsAvailable(deps, sessionName),
            }
          : {}),
        defaultSupervisorTimeoutMs: deps.config.maxWaitDoneTotalMs,
        notifications: deps.notifications,
        projectSessionPrefix: deps.config.projectSessionPrefix,
        skipRepositoryReview: true,
        hostPower: deps.config.hostPower,
        automationCoordinator,
        automationAgent,
        automationContext,
      });
      log.info("loop engineering tick complete", { data: result });
    } catch (err) {
      log.error("loop engineering tick failed", { err });
    } finally {
      tickInFlight = false;
    }
  };
  const repositoryReviewTick = async (): Promise<void> => {
    if (repositoryReviewTickInFlight) return;
    repositoryReviewTickInFlight = true;
    try {
      await refreshCapacity();
      await runLoopServiceTickAsync({
        configFile: config.configFile,
        now: Date.now(),
        schedulerStore,
        runCommand: runShellCommand,
        runGit: runGitCommand,
        runSupervisorTask: createLoopSupervisorTaskRunner(deps),
        cleanupCompletedWorkerSession: async (sessionName) => {
          await deps.bridge.killSession(sessionName);
          cleanupWorkerSessionRecords(sessionName);
        },
        workerSessionExists: (sessionName) => deps.bridge.hasSession(sessionName),
        supervisorSessionNames: supervisorSessions,
        resetSupervisorBeforeWorkOrder: deps.config.loopEngineering.supervisor.resetBeforeWorkOrder,
        supervisorWorktreeIsolation: deps.config.loopEngineering.supervisor.worktreeIsolation,
        ...(deps.config.loopEngineering.supervisor.enabled
          ? {
              ensureSupervisorSession: async (sessionName) =>
                startLoopSupervisor(deps, undefined, sessionName),
              isSupervisorSessionAvailable: async (sessionName) =>
                supervisorSessionIsAvailable(deps, sessionName),
            }
          : {}),
        defaultSupervisorTimeoutMs: deps.config.maxWaitDoneTotalMs,
        notifications: deps.notifications,
        projectSessionPrefix: deps.config.projectSessionPrefix,
        repositoryReviewOnly: true,
        hostPower: deps.config.hostPower,
        automationCoordinator,
        automationAgent,
        automationContext,
      });
    } catch (err) {
      log.error("repository PR review queue tick failed", { err });
    } finally {
      repositoryReviewTickInFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), config.tickMs);
  const repositoryReviewTimer = setInterval(
    () => void repositoryReviewTick(),
    Math.min(config.tickMs, REPOSITORY_REVIEW_MIN_TICK_MS),
  );
  const remoteBranchTimer = setInterval(
    () => void reconcileRemoteBranches(),
    REMOTE_BRANCH_RECONCILIATION_TICK_MS,
  );
  timer.unref();
  repositoryReviewTimer.unref();
  remoteBranchTimer.unref();
  void tick();
  void repositoryReviewTick();
  return () => {
    clearInterval(timer);
    clearInterval(repositoryReviewTimer);
    clearInterval(remoteBranchTimer);
  };
}

async function supervisorSessionIsAvailable(
  deps: HandlerDeps,
  sessionName: string,
): Promise<boolean> {
  if (supervisorSessionHasQueuedWork(deps, sessionName)) return false;
  return agentIsIdle(deps, sessionName);
}

function supervisorSessionHasQueuedWork(deps: HandlerDeps, sessionName: string): boolean {
  return (
    deps.queue.isSessionProcessing(sessionName) ||
    deps.queue.getSessionQueue(sessionName).length > 0 ||
    deps.queue.size(sessionName) > 0
  );
}

async function supervisorWorkerSessionOwnsActiveTurn(
  deps: HandlerDeps,
  sessionName: string,
  agent: AgentKind,
): Promise<boolean> {
  if (!(await deps.bridge.hasSession(sessionName))) return false;
  const agentRunning =
    agent === "codex"
      ? await deps.configResolver.isCodexRunning(sessionName)
      : await deps.configResolver.isClaudeRunning(sessionName);
  if (!agentRunning) return false;
  const pane = await deps.bridge.capturePane(sessionName).catch(() => "");
  return paneHasActiveTurn(pane) || paneNeedsConfirm(pane);
}

function ownerInteractiveWorkBusy(deps: HandlerDeps): boolean {
  const isOwnerWork = (origin: "user" | "system" | undefined): boolean => origin !== "system";
  if (deps.queue.getGlobalQueue().some((message) => isOwnerWork(message.origin))) return true;
  const currentGlobal = deps.queue.getCurrentGlobalMessage();
  if (currentGlobal !== undefined && isOwnerWork(currentGlobal.origin)) return true;
  return deps.queue.getSessionNames().some((session) => {
    if (deps.queue.getSessionQueue(session).some((message) => isOwnerWork(message.origin))) {
      return true;
    }
    const current = deps.queue.getCurrentSessionMessage(session);
    return current !== undefined && isOwnerWork(current.origin);
  });
}

export async function reconcileLoopSupervisorWorkOrders(input: {
  configFile: string;
  now: number;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  runSupervisorRevision?: (input: {
    workOrder: LoopWorkOrder;
    supervisorSession: string;
    failures: string[];
    attempt: number;
    maxAttempts: number;
    previousOutput: string;
  }) => Promise<LoopSupervisedRunResult>;
  cleanupCompletedWorkerSession?: (sessionName: string) => Promise<void>;
  workerSessionExists?: (sessionName: string) => Promise<boolean>;
  workerSessionOwnsActiveTurn?: (input: {
    workerSession: string;
    workOrder: LoopWorkOrder;
  }) => Promise<boolean> | boolean;
  /** Live-process guard for periodic reconciliation. Startup callers omit this
   * so durable final summaries can recover work after the old process is gone. */
  supervisorSessionBusy?: (sessionName: string) => boolean;
}): Promise<{ checked: number; recovered: number; failed: number }> {
  const config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
  const registry = readLoopSupervisorWorkOrderRegistry(input.now);
  const staleDispatchingIds = new Set(
    registry.staleDispatching.map((record) => record.workOrder.id),
  );
  const unfinished = [
    ...registry.recoverableFinalSummary,
    ...registry.unfinished,
    ...registry.recoverableFailed,
    ...registry.staleDispatching,
  ];
  const schedulerStore = new LoopSchedulerStore();
  const taskLedger = new DailyTaskLedger();
  const maxSupervisorRevisionAttempts = configuredSupervisorRevisionMaxAttempts();
  let checked = 0;
  let recovered = 0;
  let failed = 0;
  const busyWorkOrderIds = new Set<string>();

  for (const record of new Map(unfinished.map((entry) => [entry.workOrder.id, entry])).values()) {
    // A supervisor writes its summary before its queue turn resolves. Periodic
    // reconciliation must not race that live owner into duplicate revisions or
    // overwrite the terminal state back to `in-flight`.
    if (input.supervisorSessionBusy?.(record.state.supervisorSession) === true) {
      busyWorkOrderIds.add(record.workOrder.id);
      continue;
    }
    const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
    const staleDispatching =
      staleDispatchingIds.has(record.workOrder.id) &&
      record.state.status === "dispatching" &&
      !parsed.ok;
    if (!parsed.ok && !staleDispatching) continue;
    const project = systemGateProjectForRecoveredWorkOrder(config, record.workOrder);
    checked++;

    const recoveredResult: LoopSupervisedRunResult | undefined = staleDispatching
      ? {
          status: "dispatch-failed",
          reason: "dispatch reservation expired before a supervisor worker lease was acquired",
          output: "dispatch reservation expired before a supervisor worker lease was acquired",
        }
      : parsed.ok
        ? {
            status: supervisorFinalStatusToRunStatus(parsed.summary.status),
            summary: parsed.summary,
            output: `recovered supervisor final summary from ${
              record.workOrder.finalSummaryPath ?? "work order state"
            }`,
          }
        : undefined;
    if (recoveredResult === undefined) continue;
    let gate = runSupervisedSystemGateOutcome({
      project,
      workOrder: record.workOrder,
      result: recoveredResult,
      runCommand: input.runCommand,
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
      allowMissingPreparedIsolatedWorktree: true,
    });
    let revisionAttempt = 0;
    let revisionFailures = supervisorRevisionFailures(gate.failures);
    while (
      revisionFailures.length > 0 &&
      revisionAttempt < maxSupervisorRevisionAttempts &&
      input.runSupervisorRevision !== undefined
    ) {
      revisionAttempt += 1;
      writeLoopSupervisorWorkOrderState({
        workOrder: record.workOrder,
        supervisorSession: record.state.supervisorSession,
        status: "needs-revision",
        now: Date.now(),
        resultStatus: gate.result.status,
        revisionAttempt,
        revisionReasons: revisionFailures,
      });
      log.warn("loop engineering recovered system gate requesting revision", {
        data: {
          runId: record.workOrder.id,
          projectId: record.workOrder.projectId,
          supervisorSession: record.state.supervisorSession,
          revisionAttempt,
          supervisorRevisionMaxAttempts: maxSupervisorRevisionAttempts,
          failures: revisionFailures,
        },
      });
      const revised = await input.runSupervisorRevision({
        workOrder: record.workOrder,
        supervisorSession: record.state.supervisorSession,
        failures: revisionFailures,
        attempt: revisionAttempt,
        maxAttempts: maxSupervisorRevisionAttempts,
        previousOutput: gate.result.output,
      });
      const recoveredRevision = await recoverInvalidOutputFromFinalSummaryAsync(
        record.workOrder,
        revised,
      );
      gate = runSupervisedSystemGateOutcome({
        project,
        workOrder: record.workOrder,
        result: recoveredRevision,
        runCommand: input.runCommand,
        ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
        allowMissingPreparedIsolatedWorktree: true,
      });
      revisionFailures = supervisorRevisionFailures(gate.failures);
    }
    const result = gate.result;

    const completion = completeLoopSupervisorRun({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      startedAt: record.state.updatedAt,
      endedAt: input.now,
      result,
    });
    writeSupervisedSystemGateArtifact({
      workOrder: record.workOrder,
      report: completion.report,
      gate,
      result,
      writtenAt: input.now,
    });
    settleSupervisorWorkOrderOutcome({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      startedAt: record.state.updatedAt,
      endedAt: input.now,
      resultStatus: result.status,
      stateStatus: workOrderStateForResult(result),
      reportPath: completion.report.markdownPath,
      ...(result.status === "completed"
        ? { summary: result.summary.actionsTaken.join("; ") || result.status }
        : { failureSummary: "Recovered loop supervisor run did not complete successfully." }),
      closeBlockedRepairStatus: result.status === "blocked" && gate.failures.length === 0,
      advanceScheduler: !completion.retrySchedule && result.status !== "invalid-output",
      writeState: writeLoopSupervisorWorkOrderState,
      settleLease: (workOrder, resultStatus, now) =>
        settleLoopSupervisorWorkerLeaseForStatus(workOrder, resultStatus, now),
      scheduler: schedulerStore,
      ledger: taskLedger,
    });

    recovered++;
    if (result.status !== "completed") failed++;
  }

  const resources = await reconcileTerminalSupervisorResources({
    now: input.now,
    excludedWorkOrderIds: busyWorkOrderIds,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
    ...(input.cleanupCompletedWorkerSession === undefined
      ? {}
      : { cleanupWorkerSession: input.cleanupCompletedWorkerSession }),
    ...(input.workerSessionExists === undefined
      ? {}
      : { workerSessionExists: input.workerSessionExists }),
    ...(input.workerSessionOwnsActiveTurn === undefined
      ? {}
      : { workerSessionOwnsActiveTurn: input.workerSessionOwnsActiveTurn }),
  });
  checked += resources.abandonedWorkOrders;
  failed += resources.abandonedWorkOrders;

  return { checked, recovered, failed };
}

function settleLoopSupervisorWorkerLease(
  workOrder: LoopWorkOrder,
  result: LoopSupervisedRunResult,
  now: number,
  cleanupFailed = false,
): void {
  settleLoopSupervisorWorkerLeaseForStatus(workOrder, result.status, now, cleanupFailed);
}

function terminalStateToResultStatus(
  status: LoopSupervisorWorkOrderStateStatus,
): LoopSupervisedRunResult["status"] {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "supervisor-failed";
}

function settleLoopSupervisorWorkerLeaseForStatus(
  workOrder: LoopWorkOrder,
  resultStatus: LoopSupervisedRunResult["status"],
  now: number,
  cleanupFailed = false,
): void {
  const retainFailureForMs =
    (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000;
  writeLoopSupervisorWorkerLeaseState(
    releaseLoopSupervisorWorker({
      state: readLoopSupervisorWorkerLeaseState(),
      workOrderId: workOrder.id,
      result: workerLeaseOutcome(resultStatus, cleanupFailed),
      now,
      retainFailureForMs,
    }),
  );
  log.info("loop engineering settled supervisor worker lease after system gate", {
    data: {
      workOrderId: workOrder.id,
      projectId: workOrder.projectId,
      resultStatus,
      leaseResult: workerLeaseOutcome(resultStatus, cleanupFailed),
    },
  });
}

function isPreparedIsolatedExecutionWorktree(workOrder: LoopWorkOrder): boolean {
  return (
    workOrder.executionIsolation?.preparedBy === "system-git-worktree" &&
    workOrder.executionIsolation.worktreeIsolation === "isolated" &&
    isBotOwnedLoopExecutionWorktree(workOrder.projectPath)
  );
}

function systemGateProjectForRecoveredWorkOrder(
  config: ReturnType<typeof parseLoopConfigYaml>,
  workOrder: LoopWorkOrder,
): SupervisedSystemGateProject {
  const configuredProject = config.projects.find(
    (candidate) => candidate.id === workOrder.projectId,
  );
  return {
    ...systemGateProjectFromWorkOrder(workOrder),
    ...(configuredProject === undefined ? {} : { name: configuredProject.name }),
  };
}

export type SupervisedSystemGateOutcome = {
  result: LoopSupervisedRunResult;
  failures: string[];
  evidence: string[];
};

export type SystemGateFinding = {
  code: string;
  repairDisposition: "bot-repairable" | "target-or-external-blocker";
  retry: "automatic" | "manual";
  evidence: string[];
  display: string;
};

export function writeSupervisedSystemGateArtifact(input: {
  workOrder: LoopWorkOrder;
  report: ReturnType<typeof completeLoopSupervisorRun>["report"];
  gate: SupervisedSystemGateOutcome;
  result: LoopSupervisedRunResult;
  writtenAt: number;
}): void {
  const path = join(dirname(input.report.summaryPath), LOOP_RUN_ARTIFACTS.systemGate);
  const repairDisposition =
    input.gate.result.repairDisposition ?? systemGateFailureRepairDisposition(input.gate.failures);
  const evalReport =
    "summary" in input.result
      ? buildEvalReportFromSupervisorSummary({
          workOrderId: input.workOrder.id,
          taskId: input.workOrder.task?.kind ?? "architecture",
          summary: input.result.summary,
        })
      : null;
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        workOrderId: input.workOrder.id,
        projectId: input.workOrder.projectId,
        resultStatus: input.result.status,
        accepted: isAcceptedSupervisorSystemGateResult(input.result, input.gate.failures),
        supervisorReviewGate:
          "summary" in input.result ? (input.result.summary.reviewGate ?? null) : null,
        evalReport,
        evidence: input.gate.evidence,
        failures: input.gate.failures,
        ...(repairDisposition === undefined ? {} : { repairDisposition }),
        findings: systemGateFindings(input.gate, repairDisposition),
        recoverableFailures: supervisorRevisionFailures(input.gate.failures),
        writtenAt: input.writtenAt,
      },
      null,
      2,
    )}\n`,
  );
}

function isAcceptedSupervisorSystemGateResult(
  result: LoopSupervisedRunResult,
  failures: string[],
): boolean {
  if (failures.length > 0) return false;
  return result.status === "completed" || result.status === "blocked";
}

function systemGateFindings(
  input: SupervisedSystemGateOutcome,
  disposition: SystemGateFinding["repairDisposition"] | undefined,
): SystemGateFinding[] {
  if (disposition === undefined) return [];
  const dispatchDisposition = input.result.repairDisposition;
  const display =
    dispatchDisposition !== undefined
      ? "reason" in input.result
        ? input.result.reason
        : input.result.output
      : input.failures.join("; ");
  return [
    {
      code: dispatchDisposition !== undefined ? input.result.status : `system-gate-${disposition}`,
      repairDisposition: disposition,
      retry: disposition === "bot-repairable" ? "automatic" : "manual",
      evidence: dispatchDisposition !== undefined ? input.evidence : input.failures,
      display,
    },
  ];
}

function systemGateFailureRepairDisposition(
  failures: string[],
): SystemGateFinding["repairDisposition"] | undefined {
  if (failures.length === 0) return undefined;
  return failures.some(isTargetOrExternalSystemGateFailure)
    ? "target-or-external-blocker"
    : undefined;
}

function isTargetOrExternalSystemGateFailure(failure: string): boolean {
  return (
    isSystemOwnedSystemGateFailure(failure) ||
    failure.startsWith("GitHub account ") ||
    failure.startsWith("PR lookup failed:") ||
    failure.startsWith("PR lookup after body cleanup failed:") ||
    failure.startsWith("PR lookup while waiting for checks failed:") ||
    failure.startsWith("PR check wait failed:") ||
    failure.startsWith("CI check ") ||
    failure.startsWith("PR state is ") ||
    failure.startsWith("PR mergeability is ") ||
    failure.startsWith("PR is not mergeable:") ||
    failure.startsWith("unexpected PR commit count:") ||
    failure.startsWith("PR is missing supervisor commit ") ||
    failure.startsWith("PR contains commit outside supervisor summary:") ||
    failure.startsWith("source git status failed:") ||
    failure.startsWith("source worktree is dirty after supervisor completion:") ||
    failure.startsWith("source git branch check failed:") ||
    failure.startsWith("source branch is ")
  );
}

function isSystemOwnedSystemGateFailure(failure: string): boolean {
  return (
    failure.startsWith("git status failed:") ||
    failure.startsWith("git fetch origin ") ||
    failure.startsWith("isolated worktree branch check failed:") ||
    failure.startsWith("isolated worktree restore failed:")
  );
}

export function runSupervisedSystemGateOutcome(input: {
  project: SupervisedSystemGateProject;
  workOrder: LoopWorkOrder;
  result: LoopSupervisedRunResult;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  allowMissingPreparedIsolatedWorktree?: boolean;
}): SupervisedSystemGateOutcome {
  if (input.result.status !== "completed") {
    return {
      result: input.result,
      failures: [],
      evidence: [`supervisor result was ${input.result.status}; system acceptance gate skipped`],
    };
  }

  const failures: string[] = [];
  const evidence: string[] = [];
  const evalReport = buildEvalReportFromSupervisorSummary({
    workOrderId: input.workOrder.id,
    taskId: input.workOrder.task?.kind ?? "architecture",
    summary: input.result.summary,
  });
  evidence.push(`eval outcome=${evalReport.outcome.status}`);
  if (evalReport.outcome.status !== "passed") {
    failures.push(
      `eval outcome is ${evalReport.outcome.status}${
        evalReport.outcome.reason === undefined ? "" : `: ${evalReport.outcome.reason}`
      }`,
    );
  }
  const reviewGate = input.result.summary.reviewGate;
  if (reviewGate === undefined) {
    evidence.push("supervisor reviewGate not reported; deterministic system gates still enforced");
    if (input.workOrder.task?.kind === "automation-governance-review") {
      failures.push("supervisor reviewGate is required for automation governance review");
    }
  } else {
    evidence.push(
      `supervisor reviewGate decision=${reviewGate.decision}, aiReview=${reviewGate.aiReview}`,
    );
    if (reviewGate.decision !== "pass") {
      failures.push(`supervisor reviewGate decision is ${reviewGate.decision}`);
    }
  }
  const discoveryOnlyTask = input.workOrder.task?.kind === "opportunity-discovery";
  const requiresGitGate =
    !discoveryOnlyTask && (input.project.commit.enabled || input.project.pullRequest.enabled);
  const sourceWorktree = input.workOrder.executionIsolation?.sourceWorktree;
  if (input.workOrder.workspace !== undefined && input.runGit !== undefined) {
    failures.push(...workspaceRepositoryGate(input.workOrder.workspace, input.runGit));
    if (failures.length === 0) {
      evidence.push(
        `workspace repositories clean and switched back (${input.workOrder.workspace.repositories.length})`,
      );
    }
  }
  const missingRecoveredPreparedIsolatedWorktree =
    input.allowMissingPreparedIsolatedWorktree === true &&
    isPreparedIsolatedExecutionWorktree(input.workOrder) &&
    !existsSync(input.project.path);
  if (requiresGitGate && input.runGit === undefined) {
    failures.push("missing git adapter for supervised system gate");
  } else if (requiresGitGate && input.runGit !== undefined) {
    const runGit = input.runGit;
    let targetWorktreeClean = missingRecoveredPreparedIsolatedWorktree;
    if (missingRecoveredPreparedIsolatedWorktree) {
      evidence.push("prepared isolated worktree already cleaned after supervisor completion");
    } else {
      const status = runGit({ cwd: input.project.path, args: ["status", "--porcelain"] });
      if (status.status !== 0) {
        failures.push(`git status failed: ${status.stderr || status.stdout || "unknown error"}`);
      } else if (status.stdout.trim().length > 0) {
        failures.push(`worktree is dirty after supervisor completion: ${status.stdout.trim()}`);
      } else {
        targetWorktreeClean = true;
        evidence.push("target worktree clean");
      }
    }
    if (targetWorktreeClean && !missingRecoveredPreparedIsolatedWorktree) {
      const restored = restoreIsolatedExecutionBranch(input.project, input.workOrder, input.runGit);
      failures.push(...restored.failures);
      evidence.push(...restored.evidence);
    }
    if (!missingRecoveredPreparedIsolatedWorktree) {
      failures.push(...isolatedExecutionBranchGate(input.project, input.workOrder, input.runGit));
    }

    if (input.project.pullRequest.enabled) {
      failures.push(
        ...switchBackWorktreeGate({
          path: sourceWorktree ?? input.project.path,
          expectedBranch: input.project.pullRequest.switchBack,
          isolated: sourceWorktree !== undefined,
          runGit: input.runGit,
        }),
      );
      if (failures.length === 0) {
        evidence.push(
          sourceWorktree === undefined
            ? `target branch switched back to ${input.project.pullRequest.switchBack}`
            : `source worktree remained on ${input.project.pullRequest.switchBack}`,
        );
      }

      if (
        failures.length === 0 &&
        (input.workOrder.task?.kind === "pull-request-review" ||
          input.workOrder.task?.kind === "repository-pull-request-review") &&
        input.project.pullRequest.autoMerge &&
        !missingRecoveredPreparedIsolatedWorktree
      ) {
        const syncFailures = syncRepositoryReviewSwitchBackBranch({
          project: input.project,
          workOrder: input.workOrder,
          runGit: input.runGit,
        });
        failures.push(...syncFailures);
        if (
          syncFailures.length === 0 &&
          shouldSyncRepositoryReviewToDetachedBase(input.workOrder)
        ) {
          evidence.push(
            `isolated repository review synced to origin/${input.project.pullRequest.switchBack}`,
          );
        }
      }
    }
  }

  const supervisorCommitRefs = input.result.summary.commits
    .map((commit) => commit.trim())
    .filter(Boolean);
  const supervisorCommits = supervisorCommitRefs
    .map(normalizeSupervisorCommitId)
    .filter((commit): commit is string => commit !== null);
  const ignoredSupervisorCommitRefs = supervisorCommitRefs.filter(
    (commit) => normalizeSupervisorCommitId(commit) === null,
  );
  if (ignoredSupervisorCommitRefs.length > 0) {
    log.warn("loop engineering ignored non-commit supervisor summary entries", {
      data: {
        projectId: input.project.id,
        projectName: input.project.name,
        ignoredSupervisorCommitRefs,
      },
    });
  }

  const requiresLoopCreatedPullRequestGate =
    input.workOrder.task?.kind !== "pull-request-review" &&
    input.workOrder.task?.kind !== "repository-pull-request-review" &&
    !discoveryOnlyTask;

  if (
    requiresLoopCreatedPullRequestGate &&
    input.project.pullRequest.enabled &&
    supervisorCommitRefs.length > 0
  ) {
    const commitBranch = input.workOrder.commitPolicy.branch;
    if (commitBranch === undefined) {
      failures.push("pullRequest.enabled requires commit.branch for supervised system gate");
    } else if (supervisorCommits.length === 0) {
      failures.push("supervisor summary commits did not include valid commit ids");
    } else {
      const permissionFailures = runGithubAccountPermissionGate({
        project: input.project,
        runCommand: input.runCommand,
      });
      failures.push(...permissionFailures);
      if (permissionFailures.length === 0 && input.runGit !== undefined) {
        const prRunGit = input.runGit;
        const initialPrLookup = lookupSupervisedPullRequest({
          project: input.project,
          commitBranch,
          runCommand: input.runCommand,
        });
        const publication = publishMissingSupervisedPullRequest({
          project: input.project,
          workOrder: input.workOrder,
          summary: input.result.summary,
          commitBranch,
          lookup: initialPrLookup,
          runCommand: input.runCommand,
          runGit: prRunGit,
        });
        if (publication.published) {
          evidence.push("published missing supervised pull request");
        }
        if (publication.skippedNoDelta) {
          evidence.push(
            `PR gate skipped because WorkOrder branch ${commitBranch} has no commits over origin/${input.project.pullRequest.base}`,
          );
        }
        const pr = publication.lookup;
        if (publication.skippedNoDelta) {
          // No PR can be created for a branch that is already equal to the base branch.
        } else if (publication.failure !== undefined) {
          failures.push(publication.failure);
        } else if (pr.status !== 0) {
          failures.push(`PR lookup failed: ${pr.stderr || pr.stdout || "unknown error"}`);
        } else {
          evidence.push("GitHub account permission gate passed");
          let prLookup = pr;
          const allowMergedPrSubset = supervisorSummaryReferencesMultiplePrs(input.result.summary);
          let prGate = supervisedPullRequestGate({
            stdout: pr.stdout,
            expectedCommits: supervisorCommits,
            projectPath: input.project.path,
            allowMergedPrSubset,
            runGit: prRunGit,
          });
          if (prGate.generatedNoise) {
            const cleanupFailures = cleanGeneratedPullRequestBody({
              project: input.project,
              commitBranch,
              prLookup,
              runCommand: input.runCommand,
            });
            if (cleanupFailures.length > 0) {
              failures.push(...cleanupFailures);
            } else {
              prLookup = input.runCommand({
                kind: "pr",
                command: [
                  ghCommandPrefix(input.project),
                  "pr view",
                  shellQuoteLocal(commitBranch),
                  "--json",
                  "url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
                ].join(" "),
                cwd: input.project.path,
                env: {},
              });
              if (prLookup.status !== 0) {
                failures.push(
                  `PR lookup after body cleanup failed: ${
                    prLookup.stderr || prLookup.stdout || "unknown error"
                  }`,
                );
              } else {
                prGate = supervisedPullRequestGate({
                  stdout: prLookup.stdout,
                  expectedCommits: supervisorCommits,
                  projectPath: input.project.path,
                  allowMergedPrSubset,
                  runGit: prRunGit,
                });
              }
            }
          }
          if (
            failures.length === 0 &&
            prGate.failures.length === 0 &&
            prGate.pendingChecks.length > 0
          ) {
            prGate = waitForSupervisedPrChecks({
              project: input.project,
              commitBranch,
              expectedCommits: supervisorCommits,
              allowMergedPrSubset,
              runCommand: input.runCommand,
              runGit: prRunGit,
            });
          }
          failures.push(...prGate.failures, ...pendingCheckFailures(prGate.pendingChecks));
          if (prGate.failures.length === 0 && prGate.pendingChecks.length === 0) {
            evidence.push("PR commit, body, mergeability, and status-check gate passed");
          }
          if (failures.length === 0 && input.project.pullRequest.autoMerge) {
            const autoMergeFailures = runSupervisedAutoMerge({
              project: syncBackProjectForWorkOrder(input.project, input.workOrder),
              commitBranch,
              prState: prGate.state,
              runCommand: input.runCommand,
              runGit: prRunGit,
            });
            failures.push(...autoMergeFailures);
            if (autoMergeFailures.length === 0) {
              evidence.push("auto-merge and switch-back gate passed");
            }
          }
        }
      }
    }
  }

  if (discoveryOnlyTask) evidence.push("discovery-only task; mutating git and PR gates skipped");
  if (!requiresGitGate) evidence.push("no mutating git or PR gate required");
  if (
    requiresLoopCreatedPullRequestGate &&
    input.project.pullRequest.enabled &&
    supervisorCommitRefs.length === 0
  ) {
    evidence.push("PR gate skipped because supervisor reported no commits");
  }

  if (failures.length === 0) return { result: input.result, failures: [], evidence };
  const reason = `supervised system gate failed: ${failures.join("; ")}`;
  const failureSignature = createHash("sha256")
    .update(JSON.stringify([input.project.id, failures]))
    .digest("hex");
  logSystemGateFailure(failureSignature, "loop engineering supervised system gate failed", {
    data: {
      projectId: input.project.id,
      projectName: input.project.name,
      failures: failures.slice(0, 10),
      failureCount: failures.length,
      evidenceCount: evidence.length,
    },
  });
  return {
    result: {
      status: "supervisor-failed",
      summary: {
        ...input.result.summary,
        status: "failed",
        finalVerification: "failed",
        followUps: [...input.result.summary.followUps, reason],
      },
      output: [input.result.output, reason].filter(Boolean).join("\n"),
    },
    failures,
    evidence,
  };
}

function lookupSupervisedPullRequest(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): LoopRunCommandResult {
  return input.runCommand({
    kind: "pr",
    command: [
      ghCommandPrefix(input.project),
      "pr view",
      shellQuoteLocal(input.commitBranch),
      "--json",
      "url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
    ].join(" "),
    cwd: input.project.path,
    env: {},
  });
}

function workOrderBranchDelta(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): { status: "commits" | "none" } | { status: "unknown"; evidence?: string } {
  const range = `origin/${input.project.pullRequest.base}..${input.commitBranch}`;
  const result = input.runGit({
    cwd: input.project.path,
    args: ["rev-list", "--count", range],
  });
  if (result.status !== 0) {
    return {
      status: "unknown",
      evidence: `PR branch delta check skipped: ${result.stderr || result.stdout || "unknown error"}`,
    };
  }
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(count)) {
    return {
      status: "unknown",
      evidence: `PR branch delta check returned invalid count: ${result.stdout.trim() || "<empty>"}`,
    };
  }
  return count === 0 ? { status: "none" } : { status: "commits" };
}

function publishMissingSupervisedPullRequest(input: {
  project: SupervisedSystemGateProject;
  workOrder: LoopWorkOrder;
  summary: LoopSupervisorFinalSummary;
  commitBranch: string;
  lookup: LoopRunCommandResult;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): {
  lookup: LoopRunCommandResult;
  published: boolean;
  skippedNoDelta?: boolean;
  failure?: string;
} {
  if (!isMissingSupervisedPullRequest(input.lookup)) {
    return { lookup: input.lookup, published: false };
  }

  const allStateLookup = lookupSupervisedPullRequestByHeadInAllStates({
    project: input.project,
    commitBranch: input.commitBranch,
    runCommand: input.runCommand,
  });
  if (allStateLookup.status === "found") {
    return { lookup: allStateLookup.lookup, published: false };
  }
  if (allStateLookup.status === "failed") {
    return {
      lookup: input.lookup,
      published: false,
      failure: allStateLookup.failure,
    };
  }

  const branchDelta = workOrderBranchDelta({
    project: input.project,
    commitBranch: input.commitBranch,
    runGit: input.runGit,
  });
  if (branchDelta.status === "none") {
    return { lookup: input.lookup, published: false, skippedNoDelta: true };
  }

  const push = input.runGit({
    cwd: input.project.path,
    args: ["push", "-u", "origin", input.commitBranch],
  });
  if (push.status !== 0) {
    return {
      lookup: input.lookup,
      published: false,
      failure: `PR branch publish failed: ${push.stderr || push.stdout || "unknown error"}`,
    };
  }

  const taskKind = input.workOrder.task?.kind ?? "supervised-task";
  const body = [
    "## Summary",
    "",
    `Automated Loop Engineering result for ${input.project.name}.`,
    "",
    `- WorkOrder: \`${input.workOrder.id}\``,
    `- Task: \`${taskKind}\``,
    `- Verification: \`${input.summary.finalVerification}\``,
    `- Commits: ${input.summary.commits.map((commit) => `\`${commit}\``).join(", ")}`,
  ].join("\n");
  const create = input.runCommand({
    kind: "pr",
    command: [
      ghCommandPrefix(input.project),
      "pr create",
      "--base",
      shellQuoteLocal(input.project.pullRequest.base),
      "--head",
      shellQuoteLocal(input.commitBranch),
      "--title",
      shellQuoteLocal(`loop(${input.project.id}): ${taskKind}`),
      "--body",
      shellQuoteLocal(body),
    ].join(" "),
    cwd: input.project.path,
    env: {},
  });
  const lookup = lookupSupervisedPullRequest({
    project: input.project,
    commitBranch: input.commitBranch,
    runCommand: input.runCommand,
  });
  if (lookup.status === 0) {
    return { lookup, published: create.status === 0 };
  }
  return {
    lookup,
    published: false,
    failure:
      create.status === 0
        ? `PR lookup after publication failed: ${lookup.stderr || lookup.stdout || "unknown error"}`
        : `PR creation failed: ${create.stderr || create.stdout || "unknown error"}`,
  };
}

function lookupSupervisedPullRequestByHeadInAllStates(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}):
  | { status: "found"; lookup: LoopRunCommandResult }
  | { status: "missing" }
  | { status: "failed"; failure: string } {
  const list = input.runCommand({
    kind: "pr",
    command: [
      ghCommandPrefix(input.project),
      "pr list",
      "--state",
      "all",
      "--head",
      shellQuoteLocal(input.commitBranch),
      "--json",
      "number",
      "--limit",
      "1",
    ].join(" "),
    cwd: input.project.path,
    env: {},
  });
  if (list.status !== 0) {
    return {
      status: "failed",
      failure: `PR all-state lookup failed: ${list.stderr || list.stdout || "unknown error"}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    return { status: "failed", failure: "PR all-state lookup returned invalid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { status: "failed", failure: "PR all-state lookup returned invalid JSON" };
  }
  if (parsed.length === 0) return { status: "missing" };

  const first = parsed[0];
  if (first === null || typeof first !== "object") {
    return { status: "failed", failure: "PR all-state lookup returned invalid PR data" };
  }
  const number = (first as { number?: unknown }).number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    return { status: "failed", failure: "PR all-state lookup returned invalid PR number" };
  }

  const lookup = input.runCommand({
    kind: "pr",
    command: [
      ghCommandPrefix(input.project),
      "pr view",
      shellQuoteLocal(String(number)),
      "--json",
      "url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
    ].join(" "),
    cwd: input.project.path,
    env: {},
  });
  if (lookup.status !== 0) {
    return {
      status: "failed",
      failure: `PR all-state view failed: ${lookup.stderr || lookup.stdout || "unknown error"}`,
    };
  }
  return { status: "found", lookup };
}

function isMissingSupervisedPullRequest(result: LoopRunCommandResult): boolean {
  if (result.status === 0) return false;
  return `${result.stderr}\n${result.stdout}`
    .toLowerCase()
    .includes("no pull requests found for branch");
}

export function supervisorRevisionFailures(failures: string[]): string[] {
  if (failures.length === 0) return [];
  return failures.every(isRecoverableSupervisorGateFailure) ? failures : [];
}

function isRecoverableSupervisorGateFailure(failure: string): boolean {
  if (isSystemOwnedSystemGateFailure(failure)) return false;
  if (failure.startsWith("GitHub account ")) return false;
  if (failure.startsWith("PR state is ")) return false;
  if (failure.startsWith("missing git adapter")) return false;
  if (failure.startsWith("missing git adapter for supervised PR file hygiene gate")) return false;
  if (failure.startsWith("pullRequest.enabled requires commit.branch")) return false;
  if (failure.startsWith("supervisor summary commits did not include valid commit ids"))
    return true;
  if (failure.startsWith("PR check wait failed")) return false;
  return true;
}

function runIdForDueProject(
  scheduledAt: number,
  projectId: string,
  jobKind: LoopTaskSchedulerJobKind,
  jobKey: string,
): string {
  const workspaceJob = jobKey.startsWith("workspace:");
  if (jobKind === "architecture") return `${scheduledAt}-${projectId}`;
  if (jobKind === "workspace-architecture") return `${scheduledAt}-${projectId}-workspace`;
  if (workspaceJob && jobKind === "bug-fix") return `${scheduledAt}-${projectId}-workspace-bug-fix`;
  if (workspaceJob && jobKind === "test-coverage")
    return `${scheduledAt}-${projectId}-workspace-test-coverage`;
  if (workspaceJob && jobKind === "security-maintenance")
    return `${scheduledAt}-${projectId}-workspace-security-maintenance`;
  if (workspaceJob && jobKind === "harness-auto")
    return `${scheduledAt}-${projectId}-workspace-harness-auto`;
  if (workspaceJob && jobKind === "opportunity-discovery")
    return `${scheduledAt}-${projectId}-workspace-opportunity-discovery`;
  if (workspaceJob && jobKind === "pull-request-review")
    return `${scheduledAt}-${projectId}-workspace-pr-review`;
  if (jobKind === "bug-fix") return `${scheduledAt}-${projectId}-bug-fix`;
  if (jobKind === "test-coverage") return `${scheduledAt}-${projectId}-test-coverage`;
  if (jobKind === "security-maintenance") return `${scheduledAt}-${projectId}-security-maintenance`;
  if (jobKind === "harness-auto") return `${scheduledAt}-${projectId}-harness-auto`;
  if (jobKind === "opportunity-discovery")
    return `${scheduledAt}-${projectId}-opportunity-discovery`;
  if (jobKind === "automation-governance-review")
    return `${scheduledAt}-${projectId}-automation-governance-review`;
  if (jobKind === "repository-pull-request-review")
    return `${scheduledAt}-${projectId}-repo-pr-review`;
  return `${scheduledAt}-${projectId}-pr-review`;
}

function workspaceJobKind(
  jobKind: LoopTaskSchedulerJobKind,
):
  | "workspace-architecture"
  | "bug-fix"
  | "test-coverage"
  | "security-maintenance"
  | "harness-auto"
  | "opportunity-discovery"
  | "pull-request-review" {
  if (
    jobKind === "workspace-architecture" ||
    jobKind === "bug-fix" ||
    jobKind === "test-coverage" ||
    jobKind === "security-maintenance" ||
    jobKind === "harness-auto" ||
    jobKind === "opportunity-discovery" ||
    jobKind === "pull-request-review"
  ) {
    return jobKind;
  }
  return "workspace-architecture";
}

function workspaceRunnerForJob(
  workspace: LoopWorkspaceConfig,
  _jobKind:
    | "workspace-architecture"
    | "bug-fix"
    | "test-coverage"
    | "security-maintenance"
    | "harness-auto"
    | "opportunity-discovery"
    | "pull-request-review",
): LoopWorkspaceConfig["runner"] {
  return workspace.runner;
}

function workspaceRepositoryGate(
  workspace: NonNullable<LoopWorkOrder["workspace"]>,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): string[] {
  const failures: string[] = [];
  for (const repository of workspace.repositories) {
    const status = runGit({ cwd: repository.path, args: ["status", "--porcelain"] });
    if (status.status !== 0) {
      failures.push(
        `${repository.id} git status failed: ${status.stderr || status.stdout || "unknown error"}`,
      );
      continue;
    }
    if (status.stdout.trim().length > 0) {
      failures.push(`${repository.id} worktree is dirty: ${status.stdout.trim()}`);
    }
    if (repository.sourcePath !== undefined) {
      failures.push(
        ...switchBackWorktreeGate({
          path: repository.sourcePath,
          expectedBranch: repository.pullRequest.switchBack,
          isolated: true,
          runGit,
        }).map((failure) => `${repository.id} ${failure}`),
      );
      continue;
    }
    const branch = runGit({ cwd: repository.path, args: ["branch", "--show-current"] });
    if (branch.status !== 0) {
      failures.push(
        `${repository.id} git branch check failed: ${
          branch.stderr || branch.stdout || "unknown error"
        }`,
      );
      continue;
    }
    if (branch.stdout.trim() !== repository.pullRequest.switchBack) {
      failures.push(
        `${repository.id} branch is "${branch.stdout.trim()}", expected "${repository.pullRequest.switchBack}"`,
      );
    }
  }
  return failures;
}

function restoreIsolatedExecutionBranch(
  project: SupervisedSystemGateProject,
  workOrder: LoopWorkOrder,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): { failures: string[]; evidence: string[] } {
  if (
    workOrder.executionIsolation?.sourceWorktree === undefined ||
    workOrder.commitPolicy.branch === undefined
  ) {
    return { failures: [], evidence: [] };
  }
  const branch = runGit({ cwd: project.path, args: ["branch", "--show-current"] });
  if (branch.status !== 0) {
    return {
      failures: [
        `isolated worktree branch check failed: ${branch.stderr || branch.stdout || "unknown error"}`,
      ],
      evidence: [],
    };
  }
  const actualBranch = branch.stdout.trim();
  if (actualBranch === workOrder.commitPolicy.branch) return { failures: [], evidence: [] };
  const switched = runGit({ cwd: project.path, args: ["switch", workOrder.commitPolicy.branch] });
  if (switched.status !== 0) {
    return {
      failures: [
        `isolated worktree branch restore failed: ${
          switched.stderr || switched.stdout || "unknown error"
        }`,
      ],
      evidence: [],
    };
  }
  return {
    failures: [],
    evidence: [`restored isolated worktree to WorkOrder branch ${workOrder.commitPolicy.branch}`],
  };
}

function isolatedExecutionBranchGate(
  project: SupervisedSystemGateProject,
  workOrder: LoopWorkOrder,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): string[] {
  if (
    workOrder.executionIsolation?.sourceWorktree === undefined ||
    workOrder.commitPolicy.branch === undefined
  ) {
    return [];
  }
  const branch = runGit({ cwd: project.path, args: ["branch", "--show-current"] });
  if (branch.status !== 0) {
    return [
      `isolated worktree branch check failed: ${branch.stderr || branch.stdout || "unknown error"}`,
    ];
  }
  const actualBranch = branch.stdout.trim();
  if (actualBranch !== workOrder.commitPolicy.branch) {
    return [
      `isolated worktree is on "${actualBranch || "detached HEAD"}", expected WorkOrder branch "${workOrder.commitPolicy.branch}"`,
    ];
  }
  return [];
}

function switchBackWorktreeGate(input: {
  path: string;
  expectedBranch: string;
  isolated: boolean;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  const failures: string[] = [];
  const branch = input.runGit({ cwd: input.path, args: ["branch", "--show-current"] });
  if (branch.status !== 0) {
    failures.push(
      `${input.isolated ? "source" : "target"} git branch check failed: ${
        branch.stderr || branch.stdout || "unknown error"
      }`,
    );
  } else if (branch.stdout.trim() !== input.expectedBranch) {
    failures.push(
      `${input.isolated ? "source" : "target"} branch is "${branch.stdout.trim()}", expected "${input.expectedBranch}"`,
    );
  }
  return failures;
}

function syncBackProjectForWorkOrder(
  project: SupervisedSystemGateProject,
  workOrder: LoopWorkOrder,
): SupervisedSystemGateProject {
  const sourceWorktree = workOrder.executionIsolation?.sourceWorktree;
  return sourceWorktree === undefined ? project : { ...project, path: sourceWorktree };
}

function shouldSyncRepositoryReviewToDetachedBase(workOrder: LoopWorkOrder): boolean {
  return (
    workOrder.executionIsolation?.sourceWorktree !== undefined &&
    workOrder.executionIsolation.worktreeIsolation === "isolated" &&
    workOrder.task?.kind === "repository-pull-request-review" &&
    workOrder.commitPolicy.branch === undefined
  );
}

export function systemGateProjectFromWorkOrder(
  workOrder: LoopWorkOrder,
): SupervisedSystemGateProject {
  return {
    id: workOrder.projectId,
    name: workOrder.projectName,
    path: workOrder.projectPath,
    commit: workOrder.commitPolicy,
    pullRequest: workOrder.pullRequestPolicy ?? {
      enabled: false,
      base: "main",
      switchBack: "main",
      autoMerge: false,
      mergeMethod: "squash",
    },
  };
}

function isSupervisorDispatchReadinessFailure(
  result: LoopSupervisedRunResult,
): result is { status: "dispatch-failed"; reason: string; output: string } {
  if (result.status !== "dispatch-failed") return false;
  const text = `${result.reason}\n${result.output}`.toLowerCase();
  return (
    text.includes("did not become ready") ||
    text.includes("no live loop supervisor session") ||
    text.includes("loop supervisor task queue is full")
  );
}

function supervisedPullRequestGate(input: {
  stdout: string;
  expectedCommits: string[];
  projectPath: string;
  allowMergedPrSubset?: boolean;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): { failures: string[]; pendingChecks: string[]; state: string | null; generatedNoise: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch {
    return {
      failures: ["PR lookup did not return JSON"],
      pendingChecks: [],
      state: null,
      generatedNoise: false,
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return {
      failures: ["PR lookup returned invalid JSON"],
      pendingChecks: [],
      state: null,
      generatedNoise: false,
    };
  }
  const pr = parsed as {
    state?: unknown;
    mergeable?: unknown;
    statusCheckRollup?: unknown;
    body?: unknown;
    files?: unknown;
    commits?: unknown;
    mergeCommit?: unknown;
  };
  const failures: string[] = [];
  const pendingChecks: string[] = [];
  const state = typeof pr.state === "string" ? pr.state : null;
  const generatedNoise = typeof pr.body === "string" && containsGeneratedPrNoise(pr.body);
  if (state !== "OPEN" && state !== "MERGED") {
    failures.push(`PR state is ${String(pr.state)}`);
  }
  if (state !== "MERGED" && pr.mergeable !== "MERGEABLE") {
    failures.push(
      pr.mergeable === "CONFLICTING"
        ? "PR is not mergeable: CONFLICTING"
        : `PR mergeability is ${String(pr.mergeable)}`,
    );
  }
  if (state !== "MERGED" && Array.isArray(pr.statusCheckRollup)) {
    for (const check of pr.statusCheckRollup) {
      if (check === null || typeof check !== "object") continue;
      const item = check as { status?: unknown; conclusion?: unknown; name?: unknown };
      const status = typeof item.status === "string" ? item.status : "";
      const conclusion = typeof item.conclusion === "string" ? item.conclusion : "";
      const name = typeof item.name === "string" ? item.name : "unnamed check";
      if (status !== "" && status !== "COMPLETED") {
        pendingChecks.push(`CI check "${name}" is ${status}`);
      } else if (conclusion !== "" && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion)) {
        failures.push(`CI check "${name}" concluded ${conclusion}`);
      }
    }
  }
  if (generatedNoise) {
    failures.push("PR body contains generated review noise");
  }

  const mergeCommit = parsePrMergeCommitOid(pr.mergeCommit);
  let expectedCommits = input.expectedCommits
    .map(normalizeSupervisorCommitId)
    .filter((commit): commit is string => commit !== null)
    .filter((commit) => mergeCommit === null || !commitIdsMatch(commit, mergeCommit));
  const prCommits = parsePrCommitOids(pr.commits);
  if (state === "MERGED" && input.allowMergedPrSubset && expectedCommits.length > 0) {
    const currentPrExpectedCommits = expectedCommits.filter((expected) =>
      prCommits.some((actual) => commitIdsMatch(expected, actual)),
    );
    if (currentPrExpectedCommits.length > 0) expectedCommits = currentPrExpectedCommits;
  }
  if (expectedCommits.length > 0) {
    failures.push(...validatePrCommitHygiene(expectedCommits, prCommits));
    if (input.runGit === undefined) {
      failures.push("missing git adapter for supervised PR file hygiene gate");
    } else {
      failures.push(
        ...validatePrFileHygiene({
          expectedCommits,
          prFiles: parsePrFilePaths(pr.files),
          projectPath: input.projectPath,
          runGit: input.runGit,
        }),
      );
    }
  }
  return { failures, pendingChecks, state, generatedNoise };
}

function waitForSupervisedPrChecks(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  expectedCommits: string[];
  allowMergedPrSubset?: boolean;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): ReturnType<typeof supervisedPullRequestGate> {
  let gate: ReturnType<typeof supervisedPullRequestGate> = {
    failures: [],
    pendingChecks: ["PR checks are pending"],
    state: null,
    generatedNoise: false,
  };
  const attempts = supervisedPrCheckPollAttempts();
  const intervalSeconds = supervisedPrCheckPollIntervalSeconds();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    log.info("loop engineering waiting for PR checks before supervised gate", {
      data: {
        projectId: input.project.id,
        projectName: input.project.name,
        commitBranch: input.commitBranch,
        attempt,
        attempts,
        intervalSeconds,
      },
    });
    const wait = input.runCommand({
      kind: "pr",
      command: `sleep ${intervalSeconds}`,
      cwd: input.project.path,
      env: {},
    });
    if (wait.status !== 0) {
      return {
        ...gate,
        failures: [
          ...gate.failures,
          `PR check wait failed: ${wait.stderr || wait.stdout || "unknown error"}`,
        ],
      };
    }

    const lookup = input.runCommand({
      kind: "pr",
      command: [
        ghCommandPrefix(input.project),
        "pr view",
        shellQuoteLocal(input.commitBranch),
        "--json",
        "url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
      ].join(" "),
      cwd: input.project.path,
      env: {},
    });
    if (lookup.status !== 0) {
      return {
        ...gate,
        failures: [
          ...gate.failures,
          `PR lookup while waiting for checks failed: ${
            lookup.stderr || lookup.stdout || "unknown error"
          }`,
        ],
      };
    }

    gate = supervisedPullRequestGate({
      stdout: lookup.stdout,
      expectedCommits: input.expectedCommits,
      projectPath: input.project.path,
      ...(input.allowMergedPrSubset === undefined
        ? {}
        : { allowMergedPrSubset: input.allowMergedPrSubset }),
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    });
    if (gate.failures.length > 0 || gate.pendingChecks.length === 0) return gate;
  }

  return gate;
}

function pendingCheckFailures(pendingChecks: string[]): string[] {
  return pendingChecks.map((check) => `${check} after waiting for completion`);
}

function supervisorSummaryReferencesMultiplePrs(
  summary: Extract<LoopSupervisedRunResult, { status: "completed" }>["summary"],
): boolean {
  const text = JSON.stringify(summary);
  const refs = new Set<string>();
  for (const match of text.matchAll(/\bPR\s*#(\d+)\b/gi)) {
    const ref = match[1];
    if (ref !== undefined) refs.add(ref);
  }
  for (const match of text.matchAll(/\/pull\/(\d+)\b/gi)) {
    const ref = match[1];
    if (ref !== undefined) refs.add(ref);
  }
  return refs.size > 1;
}

function supervisedPrCheckPollAttempts(): number {
  return positiveIntegerEnv(
    "TCB_LOOP_PR_CHECK_POLL_ATTEMPTS",
    DEFAULT_SUPERVISED_PR_CHECK_POLL_ATTEMPTS,
  );
}

function supervisedPrCheckPollIntervalSeconds(): number {
  return positiveIntegerEnv(
    "TCB_LOOP_PR_CHECK_POLL_INTERVAL_SECONDS",
    DEFAULT_SUPERVISED_PR_CHECK_POLL_INTERVAL_SECONDS,
  );
}

function configuredSupervisorRevisionMaxAttempts(): number {
  return positiveIntegerEnv(
    "TCB_LOOP_SUPERVISOR_REVISION_MAX_ATTEMPTS",
    DEFAULT_SUPERVISOR_REVISION_MAX_ATTEMPTS,
  );
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanGeneratedPullRequestBody(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  prLookup: LoopRunCommandResult;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): string[] {
  const cleaned = cleanedPullRequestBody(input.prLookup.stdout);
  if (cleaned === null) return ["PR body contains generated review noise"];
  const dir = join(appStateDir(), "loop-pr-body-cleanups");
  mkdirSync(dir, { recursive: true });
  const bodyFile = join(dir, `${input.project.id}-${Date.now()}.md`);
  writeFileSync(bodyFile, cleaned, "utf8");
  const edit = input.runCommand({
    kind: "pr",
    command: [
      ghCommandPrefix(input.project),
      "pr edit",
      shellQuoteLocal(input.commitBranch),
      "--body-file",
      shellQuoteLocal(bodyFile),
    ].join(" "),
    cwd: input.project.path,
    env: {},
  });
  if (edit.status !== 0) {
    return [`PR body cleanup failed: ${edit.stderr || edit.stdout || "unknown error"}`];
  }
  log.info("loop engineering cleaned generated PR body noise", {
    data: {
      projectId: input.project.id,
      projectName: input.project.name,
      commitBranch: input.commitBranch,
    },
  });
  return [];
}

function validatePrCommitHygiene(expectedCommits: string[], prCommits: string[]): string[] {
  const failures: string[] = [];
  if (prCommits.length !== expectedCommits.length) {
    failures.push(
      `unexpected PR commit count: expected ${expectedCommits.length}, got ${prCommits.length}`,
    );
  }
  for (const expected of expectedCommits) {
    if (!prCommits.some((actual) => commitIdsMatch(expected, actual))) {
      failures.push(`PR is missing supervisor commit ${expected}`);
    }
  }
  for (const actual of prCommits) {
    if (!expectedCommits.some((expected) => commitIdsMatch(expected, actual))) {
      failures.push(`PR contains commit outside supervisor summary: ${actual}`);
    }
  }
  return failures;
}

function validatePrFileHygiene(input: {
  expectedCommits: string[];
  prFiles: string[];
  projectPath: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  if (input.prFiles.length === 0) return [];
  const expectedFiles = new Set<string>();
  const failures: string[] = [];
  for (const commit of input.expectedCommits) {
    const result = input.runGit({
      cwd: input.projectPath,
      args: ["show", "--format=", "--name-only", commit],
    });
    if (result.status !== 0) {
      failures.push(
        `git show ${commit} failed: ${result.stderr || result.stdout || "unknown error"}`,
      );
      continue;
    }
    for (const file of result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      expectedFiles.add(file);
    }
  }
  const unexpectedFiles = input.prFiles.filter((file) => !expectedFiles.has(file));
  if (unexpectedFiles.length > 0) {
    failures.push(
      `PR contains files not produced by supervisor commits: ${unexpectedFiles.join(", ")}`,
    );
  }
  return failures;
}

function parsePrCommitOids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const commits: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const oid = (item as { oid?: unknown }).oid;
    if (typeof oid === "string" && oid.trim().length > 0) commits.push(oid.trim());
  }
  return commits;
}

function parsePrMergeCommitOid(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const oid = (value as { oid?: unknown }).oid;
  return typeof oid === "string" && oid.trim().length > 0 ? oid.trim() : null;
}

function normalizeSupervisorCommitId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^[0-9a-fA-F]{6,40}\b/.exec(trimmed);
  return match?.[0] ?? null;
}

function cleanedPullRequestBody(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const body = (parsed as { body?: unknown }).body;
  if (typeof body !== "string") return null;
  let cleaned = body
    .replace(
      /\n?<!-- This is an auto-generated comment:[\s\S]*?<!-- end of auto-generated comment:[\s\S]*?-->/g,
      "",
    )
    .replace(/\n?## Summary by CodeRabbit[\s\S]*?(?=\n## |\n<!-- |\s*$)/g, "")
    .replace(/\n?<!-- walkthrough_start -->[\s\S]*?(?=\n## |\n<!-- |\s*$)/g, "")
    .replace(/\n?<!-- release_notes_start -->[\s\S]*?(?=\n## |\n<!-- |\s*$)/g, "")
    .trim();
  if (cleaned.length > 0) cleaned += "\n";
  return cleaned !== body ? cleaned : null;
}

function parsePrFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const files: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const path = (item as { path?: unknown }).path;
    if (typeof path === "string" && path.trim().length > 0) files.push(path.trim());
  }
  return files;
}

function commitIdsMatch(expected: string, actual: string): boolean {
  return expected.startsWith(actual) || actual.startsWith(expected);
}

function containsGeneratedPrNoise(body: string): boolean {
  return [
    "<!-- This is an auto-generated comment:",
    "<!-- end of auto-generated comment:",
    "## Summary by CodeRabbit",
    "<!-- walkthrough_start -->",
    "<!-- release_notes_start -->",
  ].some((marker) => body.includes(marker));
}

function runSupervisedAutoMerge(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  prState: string | null;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  const failures: string[] = [];
  if (input.prState === "OPEN") {
    const merge = input.runCommand({
      kind: "pr",
      command: [
        ghCommandPrefix(input.project),
        "pr merge",
        "--auto",
        shellQuoteLocal(input.commitBranch),
        mergeMethodFlag(input.project.pullRequest.mergeMethod),
      ].join(" "),
      cwd: input.project.path,
      env: {},
    });
    if (merge.status !== 0) {
      if (isPullRequestHeadBehindBaseFailure(merge)) {
        const update = input.runCommand({
          kind: "pr",
          command: [
            ghCommandPrefix(input.project),
            "pr update-branch",
            shellQuoteLocal(input.commitBranch),
          ].join(" "),
          cwd: input.project.path,
          env: {},
        });
        if (update.status !== 0) {
          failures.push(
            `PR branch update after auto-merge failure failed: ${
              update.stderr || update.stdout || "unknown error"
            }`,
          );
          return failures;
        }
        const retry = input.runCommand({
          kind: "pr",
          command: [
            ghCommandPrefix(input.project),
            "pr merge",
            "--auto",
            shellQuoteLocal(input.commitBranch),
            mergeMethodFlag(input.project.pullRequest.mergeMethod),
          ].join(" "),
          cwd: input.project.path,
          env: {},
        });
        if (retry.status === 0) return syncSwitchBackBranch(input);
        failures.push(
          `PR auto-merge failed after branch update: ${
            retry.stderr || retry.stdout || "unknown error"
          }`,
        );
        return failures;
      }
      failures.push(`PR auto-merge failed: ${merge.stderr || merge.stdout || "unknown error"}`);
      return failures;
    }
  }

  return syncSwitchBackBranch(input);
}

function isPullRequestHeadBehindBaseFailure(result: LoopRunCommandResult): boolean {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /head branch is not up to date with (?:the )?base(?: branch)?/.test(detail);
}

function mergeMethodFlag(method: "squash" | "merge" | "rebase" | undefined): string {
  return `--${method ?? "squash"}`;
}

function syncSwitchBackBranch(input: {
  project: SupervisedSystemGateProject;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  const branch = input.project.pullRequest.switchBack;
  for (const args of [
    ["fetch", "origin", branch],
    ["switch", branch],
    ["merge", "--ff-only", "FETCH_HEAD"],
  ]) {
    const result = input.runGit({ cwd: input.project.path, args });
    if (result.status !== 0) {
      return [`git ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`];
    }
  }
  return [];
}

function syncRepositoryReviewSwitchBackBranch(input: {
  project: SupervisedSystemGateProject;
  workOrder: LoopWorkOrder;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  if (shouldSyncRepositoryReviewToDetachedBase(input.workOrder)) {
    return syncDetachedRemoteBase({
      project: input.project,
      branch: input.project.pullRequest.switchBack,
      runGit: input.runGit,
    });
  }
  return syncSwitchBackBranch({
    project: syncBackProjectForWorkOrder(input.project, input.workOrder),
    runGit: input.runGit,
  });
}

function syncDetachedRemoteBase(input: {
  project: SupervisedSystemGateProject;
  branch: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  for (const args of [
    ["fetch", "origin", input.branch],
    ["switch", "--detach", "FETCH_HEAD"],
  ]) {
    const result = input.runGit({ cwd: input.project.path, args });
    if (result.status !== 0) {
      return [`git ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`];
    }
  }
  return [];
}

function runGithubAccountPermissionGate(input: {
  project: SupervisedSystemGateProject;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): string[] {
  const account = input.project.pullRequest.githubAccount;
  if (account === undefined) return [];
  const command = `${ghCommandPrefix(input.project)} repo view --json viewerPermission`;
  const attempts = positiveIntegerEnv(
    "TCB_LOOP_GITHUB_PERMISSION_CHECK_ATTEMPTS",
    DEFAULT_GITHUB_PERMISSION_CHECK_ATTEMPTS,
  );
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = input.runCommand({
      kind: "pr",
      command,
      cwd: input.project.path,
      env: {},
    });
    if (result.status === 0) {
      const permission = parseViewerPermission(result.stdout);
      if (permission === null) {
        return [`GitHub account ${account} permission check returned invalid JSON`];
      }
      if (!["WRITE", "MAINTAIN", "ADMIN"].includes(permission)) {
        return [
          `GitHub account ${account} has ${permission} permission; WRITE, MAINTAIN, or ADMIN is required`,
        ];
      }
      return [];
    }

    const detail = result.stderr || result.stdout || "unknown error";
    if (attempt === attempts || !isTransientGithubPermissionFailure(detail)) {
      return [`GitHub account ${account} permission check failed: ${detail}`];
    }
    log.warn("loop engineering GitHub permission check transient failure; retrying", {
      data: { projectId: input.project.id, projectName: input.project.name, account, attempt },
    });
  }
  return [`GitHub account ${account} permission check failed: unknown error`];
}

function isTransientGithubPermissionFailure(detail: string): boolean {
  const text = detail.toLowerCase();
  return [
    "tls handshake timeout",
    "i/o timeout",
    "timed out",
    "connection reset",
    "connection refused",
    "temporary failure in name resolution",
    "could not resolve host",
    "network is unreachable",
    "bad gateway",
    "service unavailable",
    "too many requests",
  ].some((marker) => text.includes(marker));
}

function parseViewerPermission(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const permission = (parsed as { viewerPermission?: unknown }).viewerPermission;
    return typeof permission === "string" ? permission : null;
  } catch {
    return null;
  }
}

function ghCommandPrefix(project: SupervisedSystemGateProject): string {
  const account = project.pullRequest.githubAccount;
  if (account === undefined) return "gh";
  return githubCommandForAccount(account, "").trimEnd();
}

function shellQuoteLocal(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runShellCommand(invocation: LoopRunCommandInvocation): LoopRunCommandResult {
  const result = spawnSync("sh", ["-lc", invocation.command], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.error instanceof Error ? result.error.message : result.stderr,
  };
}

type SystemGateGitExecutableResolverDeps = {
  spawn: typeof spawnSync;
  exists: (path: string) => boolean;
};

export function resolveSystemGateGitExecutable(
  env: NodeJS.ProcessEnv,
  deps: SystemGateGitExecutableResolverDeps = { spawn: spawnSync, exists: existsSync },
): string {
  const discoveryPath = systemGateChildProcessEnv(env).PATH;
  const discovered = deps.spawn("/bin/sh", ["-lc", "command -v git"], {
    encoding: "utf8",
    env: { ...env, PATH: discoveryPath },
  });
  const discoveredPath = discovered.stdout.trim();
  if (discovered.status === 0 && isAbsolute(discoveredPath) && deps.exists(discoveredPath)) {
    return discoveredPath;
  }

  for (const candidate of [
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/usr/bin/git",
    "/bin/git",
  ]) {
    if (deps.exists(candidate)) return candidate;
  }

  return "git";
}

function systemGateChildProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: [...(env.PATH ?? "").split(":").filter(Boolean), ...SYSTEM_GATE_GIT_SEARCH_PATHS].join(
      ":",
    ),
  };
}

export function runGitCommand(invocation: LoopGitInvocation): LoopRunCommandResult {
  const result = spawnSync(resolveSystemGateGitExecutable(process.env), invocation.args, {
    cwd: invocation.cwd,
    env: systemGateChildProcessEnv(process.env),
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.error instanceof Error ? result.error.message : result.stderr,
  };
}
