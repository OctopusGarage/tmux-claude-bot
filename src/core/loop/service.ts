import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import type { WorktreeIsolationMode } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { agentIsIdle } from "../command/agent-ready.js";
import type { HandlerDeps } from "../deps.js";
import { buildEvalReportFromSupervisorSummary } from "../eval/report.js";
import type { NotificationGateway } from "../notifications/gateway.js";
import { OpportunityStore, parseOpportunityDiscoveryReportFile } from "../opportunities/store.js";
import { formatOpportunityDigest } from "../opportunities/view.js";
import { sessionNameFromPath } from "../projects/sessionPathMap.js";
import { cleanupWorkerSessionRecords } from "../recovery/worker-session-cleanup.js";
import { DailyTaskLedger } from "../tasks/task-ledger.js";
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
  prepareLoopExecutionWorktrees,
} from "./execution-worktree.js";
import { repositoryPullRequestReviewDisposition } from "./final-summary-contract.js";
import {
  recoverInvalidOutputFromFinalSummaryAsync,
  supervisorFinalStatusToRunStatus,
} from "./final-summary-recovery.js";
import { githubCommandForAccount } from "./github-auth.js";
import { writeLoopRunReport } from "./report.js";
import { RepositoryReviewQueue } from "./repository-review-queue.js";
import {
  type LoopGitInvocation,
  type LoopRunCommandInvocation,
  type LoopRunCommandResult,
  type LoopRunSummary,
  runLoopProject,
  runLoopProjectAsync,
} from "./run.js";
import { LoopSchedulerStore, runLoopSchedulerTick } from "./scheduler.js";
import { parseSecurityRiskAssessment } from "./security-assessment.js";
import {
  type LoopSupervisedRunResult,
  runLoopSupervisedProjectAsync,
  runLoopSupervisorRevisionAsync,
} from "./supervised-runner.js";
import { completeLoopSupervisorRun } from "./supervisor-completion.js";
import {
  allocateLoopSupervisorBatches,
  type LoopSupervisorResetMode,
  leaseLoopSupervisorWorker,
  readLoopSupervisorWorkerLeaseState,
  releaseLoopSupervisorWorker,
  writeLoopSupervisorWorkerLeaseState,
} from "./supervisor-pool.js";
import { loopSupervisorSessionNames, startLoopSupervisor } from "./supervisor-session.js";
import {
  type LoopSupervisorWorkOrderStateStatus,
  listAbandonedLoopSupervisorWorkOrders,
  listRecoverableFailedLoopSupervisorWorkOrders,
  listRecoverableFinalSummaryLoopSupervisorWorkOrders,
  listStaleDispatchingLoopSupervisorWorkOrders,
  listTerminalLoopSupervisorWorkOrders,
  listUnfinishedLoopSupervisorWorkOrders,
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
import {
  assessWorkspaceArchitecture,
  parseArchitectureAssessment,
} from "./workspace-assessment.js";

const log = createLogger("loop.service");
const DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS = 7_200_000;
const DEFAULT_SUPERVISED_PR_CHECK_POLL_ATTEMPTS = 30;
const DEFAULT_SUPERVISED_PR_CHECK_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_SUPERVISOR_REVISION_MAX_ATTEMPTS = 3;
const DEFAULT_GITHUB_PERMISSION_CHECK_ATTEMPTS = 3;
const REPOSITORY_REVIEW_QUEUE_LEASE_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_REVIEW_RETRY_BASE_MS = 15 * 60 * 1000;
const REPOSITORY_REVIEW_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const REPOSITORY_REVIEW_MIN_TICK_MS = 10_000;
const LOG_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const inFlightSupervisorSessions = new Set<string>();

/**
 * Reserve supervisor sessions synchronously before any asynchronous readiness
 * checks. This prevents concurrent service ticks from selecting the same
 * supervisor between their persisted-work checks and dispatch.
 */
export function reserveLoopSupervisorSessions(
  sessions: readonly string[],
  activeSessions: ReadonlySet<string>,
  reservations: Set<string> = inFlightSupervisorSessions,
): string[] {
  const available = sessions.filter(
    (session) => !activeSessions.has(session) && !reservations.has(session),
  );
  for (const session of available) reservations.add(session);
  return available;
}

function releaseLoopSupervisorSessions(
  sessions: readonly string[],
  reservations: Set<string> = inFlightSupervisorSessions,
): void {
  for (const session of sessions) reservations.delete(session);
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
  log.info("loop engineering scheduler tick", {
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
  /** Run only the independent repository-review discovery/consumer. */
  repositoryReviewOnly?: boolean;
  /** Keep repository review out of the main Loop tick; production uses the independent consumer. */
  skipRepositoryReview?: boolean;
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
  const supervisorSessions =
    input.supervisorSessionNames ??
    (input.supervisorSessionName !== undefined ? [input.supervisorSessionName] : []);
  const resetSupervisorBeforeWorkOrder = input.resetSupervisorBeforeWorkOrder ?? "none";
  const maxSupervisorRevisionAttempts =
    input.supervisorRevisionMaxAttempts ?? configuredSupervisorRevisionMaxAttempts();

  type DueProject = (typeof scheduler.dueProjects)[number];
  type ResolvedDue = {
    due: DueProject;
    project?: LoopProjectConfig;
    repository?: ReturnType<typeof parseLoopConfigYaml>["prReview"]["repositories"][number];
    workspace?: LoopWorkspaceConfig;
    projectPath: string;
  };

  const resolveDue = (due: DueProject): ResolvedDue => {
    const workspaceJob = due.jobKey.startsWith("workspace:");
    const project =
      due.jobKind === "repository-pull-request-review" || workspaceJob
        ? undefined
        : config.projects.find((candidate) => candidate.id === due.projectId);
    const repository =
      due.jobKind === "repository-pull-request-review"
        ? config.prReview.repositories.find((candidate) => candidate.id === due.projectId)
        : undefined;
    const workspace = workspaceJob
      ? config.workspaces.find((candidate) => candidate.id === due.projectId)
      : undefined;
    if (project === undefined && repository === undefined && workspace === undefined) {
      throw new Error(`loop scheduler produced unknown target "${due.projectId}"`);
    }
    return {
      due,
      ...(project !== undefined ? { project } : {}),
      ...(repository !== undefined ? { repository } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      projectPath: requiredProjectPath(project, repository, workspace, due.projectId),
    };
  };

  const beginLedger = (
    target: ResolvedDue,
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
    const startedAt = Date.now();
    const runId = runIdForDueProject(
      target.due.scheduledAt,
      target.due.projectId,
      target.due.jobKind,
      target.due.jobKey,
    );
    const ledgerTaskId = `loop:${target.due.jobKey}:${target.due.scheduledAt}`;
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
  ): Promise<LoopSupervisedRunResult["status"] | "manual-review"> => {
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

    let preDispatchAssessment:
      | { score: number; targetScore: number; decision: "run"; notes: string[] }
      | undefined;
    if (workspace !== undefined && due.jobKind === "workspace-architecture") {
      const assessment = assessWorkspaceArchitecture({
        targetScore: workspace.architecture.targetScore,
        repositories: workspace.repositories,
        exists: existsSync,
        runGit:
          input.runGit ?? (() => ({ status: 1, stdout: "", stderr: "git adapter unavailable" })),
      });
      if (assessment.decision === "skip") {
        recordDueTargetWithoutDispatch(
          target,
          `workspace Architecture score ${assessment.score} reached target ${assessment.targetScore}; skipped before WorkOrder dispatch. ${assessment.notes.join("; ")}`,
          "not-needed",
        );
        return "completed";
      }
      if (assessment.decision === "block" || assessment.score === null) {
        recordDueTargetWithoutDispatch(
          target,
          `workspace Architecture pre-score blocked dispatch: ${assessment.blockers.join("; ") || "assessment failed"}`,
          "blocked",
        );
        return "blocked";
      }
      preDispatchAssessment = {
        score: assessment.score,
        targetScore: assessment.targetScore,
        decision: "run",
        notes: assessment.notes,
      };
    } else if (workspace !== undefined && due.jobKind === "security-maintenance") {
      const policy = workspace.securityMaintenance.riskAssessment ?? {
        actionThreshold: 70,
        criticalThreshold: 90,
      };
      const command = policy.command;
      const assessment =
        command === undefined
          ? {
              riskScore: null,
              actionThreshold: policy.actionThreshold,
              criticalThreshold: policy.criticalThreshold,
              critical: false,
              decision: "block" as const,
              notes: [],
              blockers: ["security risk assessment command is not configured"],
            }
          : (() => {
              const commandResult = input.runCommand({
                kind: "assessment",
                command,
                cwd: workspace.root,
                env: {
                  LOOP_PROJECT_ID: workspace.id,
                  LOOP_PROJECT_NAME: workspace.name,
                  LOOP_PROJECT_AGENT: workspace.agent,
                  LOOP_PROJECT_GOAL: workspace.securityMaintenance.prompt ?? "",
                  LOOP_PROJECT_PATH: workspace.root,
                  LOOP_BOT_ROOT: process.cwd(),
                  LOOP_SECURITY_ACTION_THRESHOLD: String(policy.actionThreshold),
                  LOOP_SECURITY_CRITICAL_THRESHOLD: String(policy.criticalThreshold),
                },
              });
              return parseSecurityRiskAssessment(
                commandResult.status,
                commandResult.stdout,
                policy.actionThreshold,
                policy.criticalThreshold,
              );
            })();
      if (assessment.decision === "skip") {
        recordDueTargetWithoutDispatch(
          target,
          `workspace Security Maintenance risk score ${assessment.riskScore} was below action threshold ${assessment.actionThreshold}; skipped before WorkOrder dispatch. ${assessment.notes.join("; ")}`,
          "not-needed",
        );
        return "completed";
      }
      if (assessment.decision === "block" || assessment.riskScore === null) {
        recordDueTargetWithoutDispatch(
          target,
          `workspace Security Maintenance pre-score blocked dispatch: ${assessment.blockers.join("; ") || "assessment failed"}`,
          "blocked",
        );
        return "blocked";
      }
      preDispatchAssessment = {
        score: assessment.riskScore,
        targetScore: assessment.actionThreshold,
        decision: "run",
        notes: [
          `security action threshold=${assessment.actionThreshold}`,
          `critical threshold=${assessment.criticalThreshold}`,
          ...assessment.notes,
        ],
      };
    } else if (project !== undefined && due.jobKind === "architecture") {
      const command = project.assessment.command;
      const assessment =
        command === undefined
          ? {
              score: null,
              targetScore: project.targetScore,
              decision: "block" as const,
              notes: [],
              blockers: ["project Architecture assessment command is not configured"],
            }
          : (() => {
              const commandResult = input.runCommand({
                kind: "assessment",
                command,
                cwd: project.path,
                env: {
                  LOOP_PROJECT_ID: project.id,
                  LOOP_PROJECT_NAME: project.name,
                  LOOP_PROJECT_AGENT: project.agent,
                  LOOP_PROJECT_GOAL: project.goal,
                  LOOP_PROJECT_PATH: project.path,
                  LOOP_BOT_ROOT: process.cwd(),
                  LOOP_PROJECT_TARGET_SCORE: String(project.targetScore),
                  LOOP_PROJECT_MAX_ROUNDS: String(project.maxRounds),
                },
              });
              return parseArchitectureAssessment(
                commandResult.status,
                commandResult.stdout,
                project.targetScore,
              );
            })();
      if (assessment.decision === "skip") {
        recordDueTargetWithoutDispatch(
          target,
          `project Architecture score ${assessment.score} reached target ${assessment.targetScore}; skipped before WorkOrder dispatch. ${assessment.notes.join("; ")}`,
          "not-needed",
        );
        return "completed";
      }
      if (assessment.decision === "block" || assessment.score === null) {
        recordDueTargetWithoutDispatch(
          target,
          `project Architecture pre-score blocked dispatch: ${assessment.blockers.join("; ") || "assessment failed"}`,
          "blocked",
        );
        return "blocked";
      }
      preDispatchAssessment = {
        score: assessment.score,
        targetScore: assessment.targetScore,
        decision: "run",
        notes: assessment.notes,
      };
    } else if (project !== undefined && due.jobKind === "security-maintenance") {
      const policy = project.securityMaintenance.riskAssessment ?? {
        actionThreshold: 70,
        criticalThreshold: 90,
      };
      const command = policy.command;
      const assessment =
        command === undefined
          ? {
              riskScore: null,
              actionThreshold: policy.actionThreshold,
              criticalThreshold: policy.criticalThreshold,
              critical: false,
              decision: "block" as const,
              notes: [],
              blockers: ["security risk assessment command is not configured"],
            }
          : (() => {
              const commandResult = input.runCommand({
                kind: "assessment",
                command,
                cwd: project.path,
                env: {
                  LOOP_PROJECT_ID: project.id,
                  LOOP_PROJECT_NAME: project.name,
                  LOOP_PROJECT_AGENT: project.agent,
                  LOOP_PROJECT_GOAL: project.goal,
                  LOOP_SECURITY_ACTION_THRESHOLD: String(policy.actionThreshold),
                  LOOP_SECURITY_CRITICAL_THRESHOLD: String(policy.criticalThreshold),
                },
              });
              return parseSecurityRiskAssessment(
                commandResult.status,
                commandResult.stdout,
                policy.actionThreshold,
                policy.criticalThreshold,
              );
            })();
      if (assessment.decision === "skip") {
        recordDueTargetWithoutDispatch(
          target,
          `project Security Maintenance risk score ${assessment.riskScore} was below action threshold ${assessment.actionThreshold}; skipped before WorkOrder dispatch. ${assessment.notes.join("; ")}`,
          "not-needed",
        );
        return "completed";
      }
      if (assessment.decision === "block" || assessment.riskScore === null) {
        recordDueTargetWithoutDispatch(
          target,
          `project Security Maintenance pre-score blocked dispatch: ${assessment.blockers.join("; ") || "assessment failed"}`,
          "blocked",
        );
        return "blocked";
      }
      preDispatchAssessment = {
        score: assessment.riskScore,
        targetScore: assessment.actionThreshold,
        decision: "run",
        notes: [
          `security action threshold=${assessment.actionThreshold}`,
          `critical threshold=${assessment.criticalThreshold}`,
          ...assessment.notes,
        ],
      };
    }
    const { startedAt, runId, ledgerTaskId } = beginLedger(target);
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
    const preparationFailures: string[] = [];
    workOrder = prepareLoopExecutionWorktrees({
      workOrder,
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
      defaultMode: input.supervisorWorktreeIsolation ?? "isolated",
      onPreparationFailure: (failure) => {
        preparationFailures.push(
          `${failure.repositoryId}: ${failure.reason} (${failure.sourceWorktree})`,
        );
      },
    });
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
      const reason = `execution worktree isolation failed: ${preparationFailures.join("; ")}`;
      result = {
        status: "dispatch-failed",
        reason,
        output: reason,
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
    const reviewDisposition =
      workOrder.task?.kind === "repository-pull-request-review" && "summary" in result
        ? repositoryPullRequestReviewDisposition(result.summary)
        : workOrder.task?.kind === "repository-pull-request-review"
          ? "invalid"
          : undefined;
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
      !cleanupLoopExecutionWorktree({ worktree: workOrder.projectPath, runGit: input.runGit });
    settleLoopSupervisorWorkerLease(workOrder, result, endedAt, isolatedCleanupFailed);
    if (result.status === "completed") {
      await cleanupCompletedWorkerSession(workOrder, input.cleanupCompletedWorkerSession);
    }
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
      taskLedger.fail(ledgerTaskId, {
        endedAt,
        error: result.status,
        summary: "Loop supervisor run did not complete successfully.",
        reportPath: completion.report.markdownPath,
      });
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

  const cleanupCompletedWorkerSession = async (
    workOrder: LoopWorkOrder,
    cleanup: ((sessionName: string) => Promise<void>) | undefined,
  ): Promise<void> => {
    if (workOrder.workerSession === undefined || cleanup === undefined) return;
    try {
      await cleanup(workOrder.workerSession);
      log.info("loop engineering completed worker session cleaned up", {
        data: {
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          workerSession: workOrder.workerSession,
        },
      });
    } catch (err) {
      log.warn("failed to clean up completed loop worker session", {
        err,
        data: {
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          workerSession: workOrder.workerSession,
        },
      });
    }
  };

  const runSystemDue = async (target: ResolvedDue): Promise<void> => {
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
    if (!shouldRetrySystemSchedule(summary)) {
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
      const plan = planSupervisedDispatch(supervisedBuffer, active);
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
          batch.map(({ item, supervisorSession }) => runSupervisedDue(item, supervisorSession)),
        );
      }
    } finally {
      releaseLoopSupervisorSessions(reservedSupervisorSessions);
    }
  };

  const drainRepositoryReviewQueue = async (): Promise<void> => {
    reconcileRepositoryReviewQueueWorkOrders(repositoryReviewQueue, Date.now());
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
        const readyCount = repositoryReviewQueue.listReady(Date.now()).length;
        log.info("loop engineering repository review queue waiting for supervisor capacity", {
          data: {
            readyCount,
            activeSupervisorSessions: [...active.supervisorSessions],
            reservedSupervisorSessions,
            supervisorSessions,
          },
        });
        return;
      }

      const now = Date.now();
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
      const plan = planSupervisedDispatch(
        targets.map(({ target }) => target),
        active,
      );
      if (plan.ready.length === 0) {
        log.info("loop engineering repository review queue deferred by resource planner", {
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
            const owner = `${process.pid}:${supervisorSession}`;
            const leased = repositoryReviewQueue.lease(
              queueItem.id,
              owner,
              now,
              REPOSITORY_REVIEW_QUEUE_LEASE_MS,
            );
            if (leased === null) return;
            repositoryReviewQueue.markRunning(leased.id, owner, Date.now());
            try {
              const result = await runSupervisedDue(target, supervisorSession, false);
              if (result === "completed") {
                repositoryReviewQueue.complete(leased.id, owner, Date.now(), "completed");
              } else if (result === "manual-review") {
                repositoryReviewQueue.manualReview(
                  leased.id,
                  owner,
                  Date.now(),
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
                  Date.now(),
                  "repository review has retryable or incomplete decisions",
                  Date.now() + retryDelay,
                );
              } else {
                const retryDelay = Math.min(
                  REPOSITORY_REVIEW_RETRY_MAX_MS,
                  REPOSITORY_REVIEW_RETRY_BASE_MS * 2 ** Math.max(0, leased.attempt - 1),
                );
                repositoryReviewQueue.fail(
                  leased.id,
                  owner,
                  Date.now(),
                  `repository review supervisor result: ${result}`,
                  Date.now() + retryDelay,
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
                Date.now(),
                err instanceof Error ? err.message : String(err),
                Date.now() + retryDelay,
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

  for (const due of scheduler.dueProjects) {
    const isRepositoryReview = due.jobKind === "repository-pull-request-review";
    if (input.repositoryReviewOnly && !isRepositoryReview) continue;
    if (!input.repositoryReviewOnly && input.skipRepositoryReview && isRepositoryReview) continue;
    const target = resolveDue(due);
    const runner = target.project?.runner ?? target.repository?.runner ?? target.workspace?.runner;
    if (runner?.kind === "agent-supervised") {
      supervisedBuffer.push(target);
      continue;
    }
    await flushSupervisedBuffer();
    await runSystemDue(target);
  }
  if (!input.repositoryReviewOnly) {
    await flushSupervisedBuffer();
  } else {
    for (const due of scheduler.dueProjects) {
      if (due.jobKind !== "repository-pull-request-review") continue;
      repositoryReviewQueue.enqueue({
        repositoryId: due.projectId,
        scheduledAt: due.scheduledAt,
        priority: 1000,
        now: Date.now(),
      });
      input.schedulerStore.setLastFired(due.jobKey, due.scheduledAt);
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
  const supervisorSessions = new Set<string>();
  const projectPaths = new Set<string>();
  const resourcePaths = new Set<string>();
  for (const record of listUnfinishedLoopSupervisorWorkOrders()) {
    if (record.state.resultStatus === "invalid-output") continue;
    supervisorSessions.add(record.state.supervisorSession);
    projectPaths.add(record.workOrder.projectPath);
    for (const resourcePath of resourcePathsForWorkOrder(record.workOrder)) {
      resourcePaths.add(resourcePath);
    }
  }
  for (const lease of readLoopSupervisorWorkerLeaseState().leases) {
    if (lease.status !== "active") continue;
    supervisorSessions.add(lease.workerSession);
    projectPaths.add(lease.projectPath);
    resourcePaths.add(resolvePath(lease.projectPath));
  }
  if (supervisorSessions.size > 0) {
    log.info("loop engineering active supervisor work detected", {
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

type LoopDueTarget = {
  due: ReturnType<typeof runLoopSchedulerTick>["dueProjects"][number];
  project?: LoopProjectConfig;
  repository?: ReturnType<typeof parseLoopConfigYaml>["prReview"]["repositories"][number];
  workspace?: LoopWorkspaceConfig;
  projectPath: string;
};

type LoopDispatchPlan = {
  ready: LoopDueTarget[];
  skipped: Array<{ target: LoopDueTarget; reason: string }>;
  deferred: Array<{ target: LoopDueTarget; reason: string; conflictsWith: string[] }>;
};

function planSupervisedDispatch(
  targets: readonly LoopDueTarget[],
  active: ReturnType<typeof activeLoopSupervisorWork>,
): LoopDispatchPlan {
  const ready: LoopDueTarget[] = [];
  const skipped: LoopDispatchPlan["skipped"] = [];
  const deferred: LoopDispatchPlan["deferred"] = [];
  const selectedResources: Array<{ owner: string; path: string }> = [];
  const selectedHarnesses: LoopDueTarget[] = [];
  const ordered = targets
    .map((target, index) => ({ target, index }))
    .sort(
      (left, right) =>
        targetPriority(left.target) - targetPriority(right.target) || left.index - right.index,
    );

  for (const { target } of ordered) {
    const activeConflicts = conflictingResourceOwners(
      resourcePathsForTarget(target),
      [...active.resourcePaths].map((path) => ({ owner: "active-work", path })),
    );
    if (activeConflicts.length > 0) {
      deferred.push({
        target,
        reason: "target overlaps active loop supervisor work",
        conflictsWith: activeConflicts,
      });
      continue;
    }

    const harness = selectedHarnesses.find((candidate) => harnessCovers(candidate, target));
    if (harness !== undefined) {
      skipped.push({
        target,
        reason: `${harness.due.jobKey} harness-auto covers ${taskFamily(target)}`,
      });
      continue;
    }

    const resourceConflicts = conflictingResourceOwners(
      resourcePathsForTarget(target),
      selectedResources,
    );
    if (resourceConflicts.length > 0) {
      deferred.push({
        target,
        reason: "target overlaps another due target selected for this tick",
        conflictsWith: resourceConflicts,
      });
      continue;
    }

    ready.push(target);
    const owner = target.due.jobKey;
    for (const path of resourcePathsForTarget(target)) selectedResources.push({ owner, path });
    if (target.due.jobKind === "harness-auto") selectedHarnesses.push(target);
  }

  return {
    ready: restoreDueOrder(ready, targets),
    skipped: restoreSkippedOrder(skipped, targets),
    deferred,
  };
}

function targetPriority(target: LoopDueTarget): number {
  if (target.due.jobKind === "harness-auto") return 0;
  if (taskFamily(target) === "architecture") return 1;
  if (taskFamily(target) === "security-maintenance") return 2;
  if (taskFamily(target) === "bug-fix") return 3;
  if (taskFamily(target) === "test-coverage") return 4;
  if (target.due.jobKind === "repository-pull-request-review") return 5;
  if (target.due.jobKind === "pull-request-review") return 6;
  return 7;
}

function restoreDueOrder<T extends LoopDueTarget>(
  items: T[],
  original: readonly LoopDueTarget[],
): T[] {
  const index = new Map(original.map((target, idx) => [target.due.jobKey, idx]));
  return [...items].sort(
    (left, right) => (index.get(left.due.jobKey) ?? 0) - (index.get(right.due.jobKey) ?? 0),
  );
}

function restoreSkippedOrder(
  items: LoopDispatchPlan["skipped"],
  original: readonly LoopDueTarget[],
): LoopDispatchPlan["skipped"] {
  const index = new Map(original.map((target, idx) => [target.due.jobKey, idx]));
  return [...items].sort(
    (left, right) =>
      (index.get(left.target.due.jobKey) ?? 0) - (index.get(right.target.due.jobKey) ?? 0),
  );
}

function taskFamily(target: LoopDueTarget): string {
  return target.due.jobKind === "workspace-architecture" ? "architecture" : target.due.jobKind;
}

function harnessCovers(harness: LoopDueTarget, target: LoopDueTarget): boolean {
  if (harness === target || harness.due.jobKind !== "harness-auto") return false;
  const family = taskFamily(target);
  if (
    family !== "architecture" &&
    family !== "bug-fix" &&
    family !== "test-coverage" &&
    family !== "security-maintenance"
  ) {
    return false;
  }
  const tasks = harness.project?.harnessAuto.tasks ?? harness.workspace?.harnessAuto.tasks ?? [];
  if (!tasks.some((task) => task.kind === family && task.enabled)) return false;
  return resourcesConflict(resourcePathsForTarget(harness), resourcePathsForTarget(target));
}

function resourcePathsForTarget(target: LoopDueTarget): string[] {
  if (target.workspace !== undefined) {
    return normalizeResourcePaths([
      target.workspace.root,
      ...target.workspace.repositories.map((repository) => repository.path),
    ]);
  }
  return normalizeResourcePaths([target.projectPath]);
}

function resourcePathsForWorkOrder(workOrder: LoopWorkOrder): string[] {
  if (workOrder.workspace !== undefined) {
    return normalizeResourcePaths([
      workOrder.workspace.root,
      ...workOrder.workspace.repositories.flatMap((repository) => [
        repository.path,
        ...(repository.sourcePath === undefined ? [] : [repository.sourcePath]),
      ]),
    ]);
  }
  return normalizeResourcePaths([
    workOrder.projectPath,
    ...(workOrder.executionIsolation?.sourceWorktree === undefined
      ? []
      : [workOrder.executionIsolation.sourceWorktree]),
  ]);
}

function normalizeResourcePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolvePath(path)))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function conflictingResourceOwners(
  candidatePaths: readonly string[],
  existing: readonly { owner: string; path: string }[],
): string[] {
  return [
    ...new Set(
      existing
        .filter((item) => candidatePaths.some((candidate) => pathsOverlap(candidate, item.path)))
        .map((item) => item.owner),
    ),
  ];
}

function resourcesConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => pathsOverlap(leftPath, rightPath)));
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function requiredProject(
  project: LoopProjectConfig | undefined,
  projectId: string,
): LoopProjectConfig {
  if (project === undefined)
    throw new Error(`loop scheduler produced unknown project "${projectId}"`);
  return project;
}

function requiredProjectPath(
  project: LoopProjectConfig | undefined,
  repository:
    | ReturnType<typeof parseLoopConfigYaml>["prReview"]["repositories"][number]
    | undefined,
  workspace: LoopWorkspaceConfig | undefined,
  targetId: string,
): string {
  const path = project?.path ?? repository?.path ?? workspace?.root;
  if (path === undefined) throw new Error(`loop scheduler produced unknown target "${targetId}"`);
  return path;
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

/* c8 ignore start -- filesystem-backed WorkOrder reconciliation is exercised by live service smoke tests. */
function reconcileRepositoryReviewQueueWorkOrders(queue: RepositoryReviewQueue, now: number): void {
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

export function startLoopEngineering(
  deps: HandlerDeps,
  config: { configFile: string; tickMs: number },
): () => void {
  if (config.configFile.trim() === "" || config.tickMs === 0) return () => {};
  const restored = restoreLoopControlQueue({ queue: deps.queue });
  if (restored > 0) log.info("loop engineering control queue restored", { data: { restored } });
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
  const reconciled = reconcileLoopSupervisorWorkOrders({
    configFile: config.configFile,
    now: Date.now(),
    runCommand: runShellCommand,
    runGit: runGitCommand,
  });
  if (reconciled.checked > 0) {
    log.info("loop engineering supervisor work order reconcile complete", { data: reconciled });
  }
  const schedulerStore = new LoopSchedulerStore();
  let tickInFlight = false;
  let repositoryReviewTickInFlight = false;
  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      log.warn("loop engineering tick skipped because previous tick is still running");
      return;
    }
    tickInFlight = true;
    try {
      const reconciled = reconcileLoopSupervisorWorkOrders({
        configFile: config.configFile,
        now: Date.now(),
        runCommand: runShellCommand,
        runGit: runGitCommand,
      });
      if (reconciled.checked > 0) {
        log.info("loop engineering supervisor work order reconcile complete", { data: reconciled });
      }
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
        supervisorSessionNames: loopSupervisorSessionNames(
          deps.config.projectSessionPrefix,
          deps.config.loopEngineering.supervisor.poolSize,
        ),
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
        supervisorSessionNames: loopSupervisorSessionNames(
          deps.config.projectSessionPrefix,
          deps.config.loopEngineering.supervisor.poolSize,
        ),
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
  timer.unref();
  repositoryReviewTimer.unref();
  void tick();
  void repositoryReviewTick();
  return () => {
    clearInterval(timer);
    clearInterval(repositoryReviewTimer);
  };
}

async function supervisorSessionIsAvailable(
  deps: HandlerDeps,
  sessionName: string,
): Promise<boolean> {
  if (deps.queue.isSessionProcessing(sessionName)) return false;
  if (deps.queue.getSessionQueue(sessionName).length > 0) return false;
  if (deps.queue.size(sessionName) > 0) return false;
  return agentIsIdle(deps, sessionName);
}

export function reconcileLoopSupervisorWorkOrders(input: {
  configFile: string;
  now: number;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): { checked: number; recovered: number; failed: number } {
  const config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
  const unfinished = [
    ...listRecoverableFinalSummaryLoopSupervisorWorkOrders(),
    ...listUnfinishedLoopSupervisorWorkOrders(),
    ...listRecoverableFailedLoopSupervisorWorkOrders(),
    ...listStaleDispatchingLoopSupervisorWorkOrders(input.now),
  ];
  const schedulerStore = new LoopSchedulerStore();
  const taskLedger = new DailyTaskLedger();
  let checked = 0;
  let recovered = 0;
  let failed = 0;

  for (const record of new Map(unfinished.map((entry) => [entry.workOrder.id, entry])).values()) {
    const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
    const staleDispatching =
      record.state.status === "dispatching" &&
      !parsed.ok &&
      !readLoopSupervisorWorkerLeaseState().leases.some(
        (lease) => lease.status === "active" && lease.workOrderId === record.workOrder.id,
      );
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
    const gate = runSupervisedSystemGateOutcome({
      project,
      workOrder: record.workOrder,
      result: recoveredResult,
      runCommand: input.runCommand,
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    });
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
    writeLoopSupervisorWorkOrderState({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      status: workOrderStateForResult(result),
      now: input.now,
      resultStatus: result.status,
    });
    settleLoopSupervisorWorkerLease(record.workOrder, result, input.now);
    const jobKey = jobKeyForWorkOrder(record.workOrder);
    if (!completion.retrySchedule && result.status !== "invalid-output")
      schedulerStore.setLastFired(jobKey, record.workOrder.scheduledAt);
    const ledgerTaskId = `loop:${jobKey}:${record.workOrder.scheduledAt}`;
    taskLedger.expect({
      taskId: ledgerTaskId,
      source: "loop-engineering",
      name: `${record.workOrder.projectId} ${record.workOrder.task?.kind ?? "architecture"}`,
      scheduledAt: record.workOrder.scheduledAt,
    });
    taskLedger.start(ledgerTaskId, record.state.updatedAt);
    if (result.status === "completed") {
      taskLedger.finish(ledgerTaskId, {
        endedAt: input.now,
        summary: result.summary.actionsTaken.join("; ") || result.status,
        reportPath: completion.report.markdownPath,
      });
    } else {
      taskLedger.fail(ledgerTaskId, {
        endedAt: input.now,
        error: result.status,
        summary: "Recovered loop supervisor run did not complete successfully.",
        reportPath: completion.report.markdownPath,
      });
    }

    recovered++;
    if (result.status !== "completed") failed++;
  }

  const settledTerminalLeases = reconcileTerminalLoopSupervisorWorkerLeases(input.now);
  if (settledTerminalLeases > 0) {
    log.info("loop engineering terminal supervisor worker leases reconciled", {
      data: { settled: settledTerminalLeases },
    });
  }
  const abandonedWorkOrders = reconcileAbandonedLoopSupervisorWorkOrders(
    input.now,
    taskLedger,
    schedulerStore,
  );
  checked += abandonedWorkOrders;
  failed += abandonedWorkOrders;
  if (abandonedWorkOrders > 0) {
    log.info("loop engineering abandoned supervisor worker leases reconciled", {
      data: { settled: abandonedWorkOrders },
    });
  }
  if (input.runGit !== undefined) {
    const terminalWorktrees = reconcileTerminalLoopSupervisorWorktrees({
      now: input.now,
      runGit: input.runGit,
    });
    if (terminalWorktrees > 0) {
      log.info("loop engineering terminal supervisor worktrees reconciled", {
        data: { removed: terminalWorktrees },
      });
    }
    const expiredWorktrees = reconcileExpiredLoopSupervisorWorkerWorktrees({
      now: input.now,
      runGit: input.runGit,
    });
    if (expiredWorktrees > 0) {
      log.info("loop engineering expired supervisor worktrees reconciled", {
        data: { removed: expiredWorktrees },
      });
    }
  }

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

function reconcileTerminalLoopSupervisorWorkerLeases(now: number): number {
  const activeLeasedWorkOrders = new Set(
    readLoopSupervisorWorkerLeaseState()
      .leases.filter((lease) => lease.status === "active")
      .map((lease) => lease.workOrderId),
  );
  let settled = 0;
  for (const record of listTerminalLoopSupervisorWorkOrders()) {
    if (!activeLeasedWorkOrders.has(record.workOrder.id)) continue;
    settleLoopSupervisorWorkerLeaseForStatus(
      record.workOrder,
      record.state.resultStatus ?? terminalStateToResultStatus(record.state.status),
      now,
    );
    settled++;
  }
  return settled;
}

function reconcileAbandonedLoopSupervisorWorkOrders(
  now: number,
  taskLedger: DailyTaskLedger,
  schedulerStore: LoopSchedulerStore,
): number {
  const activeLeasedWorkOrders = new Set(
    readLoopSupervisorWorkerLeaseState()
      .leases.filter((lease) => lease.status === "active")
      .map((lease) => lease.workOrderId),
  );
  let settled = 0;
  for (const record of listAbandonedLoopSupervisorWorkOrders()) {
    writeLoopSupervisorWorkOrderState({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      status: "failed",
      now,
      resultStatus: "invalid-output",
      revisionReasons: ["supervisor work order can no longer progress"],
    });
    schedulerStore.setLastFired(jobKeyForWorkOrder(record.workOrder), record.workOrder.scheduledAt);
    const jobKey = jobKeyForWorkOrder(record.workOrder);
    const ledgerTaskId = `loop:${jobKey}:${record.workOrder.scheduledAt}`;
    const existing = taskLedger.listAll().find((task) => task.taskId === ledgerTaskId);
    if (existing === undefined) {
      taskLedger.expect({
        taskId: ledgerTaskId,
        source: "loop-engineering",
        name: `${record.workOrder.projectId} ${record.workOrder.task?.kind ?? "architecture"}`,
        scheduledAt: record.workOrder.scheduledAt,
      });
      taskLedger.start(ledgerTaskId, record.state.updatedAt);
    }
    if (existing?.status !== "failed" && existing?.status !== "success") {
      taskLedger.fail(ledgerTaskId, {
        endedAt: now,
        error: "supervisor work order can no longer progress",
        summary: "Reconciled stale supervisor dispatch without an active worker lease.",
        reportPath: record.runDir,
      });
    }
    if (activeLeasedWorkOrders.has(record.workOrder.id)) {
      settleLoopSupervisorWorkerLeaseForStatus(record.workOrder, "invalid-output", now);
    }
    settled++;
  }
  return settled;
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
      result: resultStatus === "completed" && !cleanupFailed ? "success" : "failure",
      now,
      retainFailureForMs,
    }),
  );
  log.info("loop engineering settled supervisor worker lease after system gate", {
    data: {
      workOrderId: workOrder.id,
      projectId: workOrder.projectId,
      resultStatus,
      leaseResult: resultStatus === "completed" && !cleanupFailed ? "success" : "failure",
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

function reconcileTerminalLoopSupervisorWorktrees(input: {
  now: number;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): number {
  let removed = 0;
  for (const record of listTerminalLoopSupervisorWorkOrders()) {
    if (!isPreparedIsolatedExecutionWorktree(record.workOrder)) continue;
    const retainFailureForMs =
      (record.workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000;
    const eligibleAt =
      record.state.status === "completed"
        ? record.state.updatedAt
        : record.state.updatedAt + retainFailureForMs;
    if (eligibleAt > input.now) continue;
    if (!existsSync(record.workOrder.projectPath)) continue;
    if (
      cleanupLoopExecutionWorktree({
        worktree: record.workOrder.projectPath,
        runGit: input.runGit,
      })
    ) {
      removed++;
    }
  }
  return removed;
}

function reconcileExpiredLoopSupervisorWorkerWorktrees(input: {
  now: number;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): number {
  const state = readLoopSupervisorWorkerLeaseState();
  const expired = state.leases.filter(
    (lease) => lease.status === "retained" && (lease.retainUntil ?? Infinity) <= input.now,
  );
  if (expired.length === 0) return 0;

  let removed = 0;
  const remaining = state.leases.filter((lease) => {
    if (!expired.includes(lease)) return true;
    if (!isBotOwnedLoopExecutionWorktree(lease.projectPath)) return true;
    if (!cleanupLoopExecutionWorktree({ worktree: lease.projectPath, runGit: input.runGit })) {
      return true;
    }
    removed++;
    return false;
  });
  if (remaining.length !== state.leases.length) {
    writeLoopSupervisorWorkerLeaseState({ leases: remaining });
  }
  return removed;
}

function systemGateProjectForRecoveredWorkOrder(
  config: ReturnType<typeof parseLoopConfigYaml>,
  workOrder: LoopWorkOrder,
): SupervisedSystemGateProject {
  const configuredProject = config.projects.find(
    (candidate) => candidate.id === workOrder.projectId,
  );
  if (configuredProject !== undefined) return configuredProject;
  return systemGateProjectFromWorkOrder(workOrder);
}

function jobKeyForWorkOrder(workOrder: LoopWorkOrder): string {
  if (workOrder.task?.kind === "repository-pull-request-review") {
    return `pr-review:${workOrder.projectId}`;
  }
  if (workOrder.task?.kind === "workspace-architecture") {
    return `workspace:${workOrder.projectId}:architecture`;
  }
  if (workOrder.task?.kind === "pull-request-review") {
    return `${workOrder.projectId}:pull-request-review`;
  }
  if (workOrder.task?.kind === "bug-fix") {
    return `${workOrder.projectId}:bug-fix`;
  }
  if (workOrder.task?.kind === "test-coverage") {
    return `${workOrder.projectId}:test-coverage`;
  }
  if (workOrder.task?.kind === "security-maintenance") {
    return `${workOrder.projectId}:security-maintenance`;
  }
  if (workOrder.task?.kind === "harness-auto") {
    return workOrder.workspace === undefined
      ? `${workOrder.projectId}:harness-auto`
      : `workspace:${workOrder.projectId}:harness-auto`;
  }
  if (workOrder.task?.kind === "opportunity-discovery") {
    return workOrder.workspace === undefined
      ? `${workOrder.projectId}:opportunity-discovery`
      : `workspace:${workOrder.projectId}:opportunity-discovery`;
  }
  if (workOrder.task?.kind === "automation-governance-review") {
    return `${workOrder.projectId}:automation-governance-review`;
  }
  return workOrder.projectId;
}

export type SupervisedSystemGateOutcome = {
  result: LoopSupervisedRunResult;
  failures: string[];
  evidence: string[];
};

export function writeSupervisedSystemGateArtifact(input: {
  workOrder: LoopWorkOrder;
  report: ReturnType<typeof completeLoopSupervisorRun>["report"];
  gate: SupervisedSystemGateOutcome;
  result: LoopSupervisedRunResult;
  writtenAt: number;
}): void {
  const path = join(dirname(input.report.summaryPath), LOOP_RUN_ARTIFACTS.systemGate);
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
        accepted: input.result.status === "completed" && input.gate.failures.length === 0,
        supervisorReviewGate:
          "summary" in input.result ? (input.result.summary.reviewGate ?? null) : null,
        evalReport,
        evidence: input.gate.evidence,
        failures: input.gate.failures,
        recoverableFailures: supervisorRevisionFailures(input.gate.failures),
        writtenAt: input.writtenAt,
      },
      null,
      2,
    )}\n`,
  );
}

export function runSupervisedSystemGateOutcome(input: {
  project: SupervisedSystemGateProject;
  workOrder: LoopWorkOrder;
  result: LoopSupervisedRunResult;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
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
  if (requiresGitGate && input.runGit === undefined) {
    failures.push("missing git adapter for supervised system gate");
  } else if (requiresGitGate && input.runGit !== undefined) {
    const status = input.runGit({ cwd: input.project.path, args: ["status", "--porcelain"] });
    if (status.status !== 0) {
      failures.push(`git status failed: ${status.stderr || status.stdout || "unknown error"}`);
    } else if (status.stdout.trim().length > 0) {
      failures.push(`worktree is dirty after supervisor completion: ${status.stdout.trim()}`);
    } else {
      evidence.push("target worktree clean");
    }
    failures.push(...isolatedExecutionBranchGate(input.project, input.workOrder, input.runGit));

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
            : `source worktree remained clean on ${input.project.pullRequest.switchBack}`,
        );
      }

      if (
        failures.length === 0 &&
        (input.workOrder.task?.kind === "pull-request-review" ||
          input.workOrder.task?.kind === "repository-pull-request-review") &&
        input.project.pullRequest.autoMerge
      ) {
        failures.push(
          ...syncSwitchBackBranch({
            project: syncBackProjectForWorkOrder(input.project, input.workOrder),
            runGit: input.runGit,
          }),
        );
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
      if (permissionFailures.length === 0) {
        const pr = input.runCommand({
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
        if (pr.status !== 0) {
          failures.push(`PR lookup failed: ${pr.stderr || pr.stdout || "unknown error"}`);
        } else {
          evidence.push("GitHub account permission gate passed");
          let prLookup = pr;
          let prGate = supervisedPullRequestGate({
            stdout: pr.stdout,
            expectedCommits: supervisorCommits,
            projectPath: input.project.path,
            ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
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
                  ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
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
              runCommand: input.runCommand,
              ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
            });
          }
          failures.push(...prGate.failures, ...pendingCheckFailures(prGate.pendingChecks));
          if (prGate.failures.length === 0 && prGate.pendingChecks.length === 0) {
            evidence.push("PR commit, body, mergeability, and status-check gate passed");
          }
          if (
            failures.length === 0 &&
            input.project.pullRequest.autoMerge &&
            input.runGit !== undefined
          ) {
            const autoMergeFailures = runSupervisedAutoMerge({
              project: syncBackProjectForWorkOrder(input.project, input.workOrder),
              commitBranch,
              prState: prGate.state,
              runCommand: input.runCommand,
              runGit: input.runGit,
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
  log.warn("loop engineering supervised system gate failed", {
    data: { projectId: input.project.id, projectName: input.project.name, failures, evidence },
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

export function supervisorRevisionFailures(failures: string[]): string[] {
  if (failures.length === 0) return [];
  return failures.every(isRecoverableSupervisorGateFailure) ? failures : [];
}

function isRecoverableSupervisorGateFailure(failure: string): boolean {
  if (failure.startsWith("GitHub account ")) return false;
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
  if (input.isolated) {
    const status = input.runGit({ cwd: input.path, args: ["status", "--porcelain"] });
    if (status.status !== 0) {
      failures.push(
        `source git status failed: ${status.stderr || status.stdout || "unknown error"}`,
      );
    } else if (status.stdout.trim().length > 0) {
      failures.push(
        `source worktree is dirty after supervisor completion: ${status.stdout.trim()}`,
      );
    }
  }

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
  const expectedCommits = input.expectedCommits
    .map(normalizeSupervisorCommitId)
    .filter((commit): commit is string => commit !== null)
    .filter((commit) => mergeCommit === null || !commitIdsMatch(commit, mergeCommit));
  if (expectedCommits.length > 0) {
    failures.push(...validatePrCommitHygiene(expectedCommits, parsePrCommitOids(pr.commits)));
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
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    });
    if (gate.failures.length > 0 || gate.pendingChecks.length === 0) return gate;
  }

  return gate;
}

function pendingCheckFailures(pendingChecks: string[]): string[] {
  return pendingChecks.map((check) => `${check} after waiting for completion`);
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
        shellQuoteLocal(input.commitBranch),
        mergeMethodFlag(input.project.pullRequest.mergeMethod),
      ].join(" "),
      cwd: input.project.path,
      env: {},
    });
    if (merge.status !== 0) {
      failures.push(`PR auto-merge failed: ${merge.stderr || merge.stdout || "unknown error"}`);
      return failures;
    }
  }

  return syncSwitchBackBranch(input);
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

export function runGitCommand(invocation: LoopGitInvocation): LoopRunCommandResult {
  const result = spawnSync("git", invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.error instanceof Error ? result.error.message : result.stderr,
  };
}
