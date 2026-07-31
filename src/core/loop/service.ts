import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { createLogger } from "../../shared/utils/logger.js";
import { agentIsIdle } from "../command/agent-ready.js";
import type { HandlerDeps } from "../deps.js";
import type { NotificationGateway } from "../notifications/gateway.js";
import { OpportunityStore, parseOpportunityDiscoveryReportFile } from "../opportunities/store.js";
import { formatOpportunityDigest } from "../opportunities/view.js";
import { sessionNameFromPath } from "../projects/sessionPathMap.js";
import { DailyTaskLedger } from "../tasks/task-ledger.js";
import {
  createLoopQueueAgentEvalRunner,
  createLoopQueueAgentTaskRunner,
  createLoopSupervisorTaskRunner,
  restoreLoopControlQueue,
} from "./agent-queue.js";
import { LoopBacklogStore } from "./backlog.js";
import { type LoopProjectConfig, type LoopWorkspaceConfig, parseLoopConfigYaml } from "./config.js";
import {
  recoverInvalidOutputFromFinalSummary,
  supervisorFinalStatusToRunStatus,
} from "./final-summary-recovery.js";
import { writeLoopRunReport } from "./report.js";
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
import {
  runGitCommand,
  runShellCommand,
  runSupervisedSystemGateOutcome,
  type SupervisedSystemGateProject,
  supervisorRevisionFailures,
  systemGateProjectFromWorkOrder,
  writeSupervisedSystemGateArtifact,
} from "./supervised-system-gate.js";
import { completeLoopSupervisorRun } from "./supervisor-completion.js";
import { allocateLoopSupervisorBatches, type LoopSupervisorResetMode } from "./supervisor-pool.js";
import { loopSupervisorSessionNames, startLoopSupervisor } from "./supervisor-session.js";
import {
  listRecoverableFailedLoopSupervisorWorkOrders,
  listUnfinishedLoopSupervisorWorkOrders,
  workOrderStateForResult,
  writeLoopSupervisorWorkOrderState,
} from "./supervisor-state.js";
import type { LoopWorkOrder } from "./work-order.js";
import {
  buildLoopWorkOrder,
  buildLoopWorkspaceWorkOrder,
  buildRepositoryPullRequestReviewWorkOrder,
  parseSupervisorFinalSummaryFile,
} from "./work-order.js";

export {
  runGitCommand,
  runShellCommand,
  runSupervisedSystemGateOutcome,
  supervisorRevisionFailures,
  systemGateProjectFromWorkOrder,
} from "./supervised-system-gate.js";

const log = createLogger("loop.service");
const DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS = 7_200_000;
const DEFAULT_SUPERVISOR_REVISION_MAX_ATTEMPTS = 3;
const LOG_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  ensureSupervisorSession?: (sessionName: string) => Promise<boolean>;
  isSupervisorSessionAvailable?: (sessionName: string) => Promise<boolean>;
  defaultSupervisorTimeoutMs?: number;
  supervisorRevisionMaxAttempts?: number;
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
  ): Promise<void> => {
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
    const workOrder =
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
                      : due.jobKind === "test-coverage"
                        ? "test-coverage"
                        : due.jobKind === "security-maintenance"
                          ? "security-maintenance"
                          : due.jobKind === "bug-fix"
                            ? "bug-fix"
                            : "architecture",
            });
    if (workOrder.finalSummaryPath !== undefined) {
      mkdirSync(dirname(workOrder.finalSummaryPath), { recursive: true });
    }
    if (workOrder.opportunityReportPath !== undefined) {
      mkdirSync(dirname(workOrder.opportunityReportPath), { recursive: true });
    }
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession,
      status: "dispatching",
      now: Date.now(),
    });
    let result: LoopSupervisedRunResult;
    if (supervisorSession === "unconfigured-loop-supervisor") {
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
        resetBeforeWorkOrder: resetSupervisorBeforeWorkOrder,
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
            resetBeforeWorkOrder: resetSupervisorBeforeWorkOrder,
            dispatch: input.runSupervisorTask,
          });
        }
      }
    }
    result = recoverInvalidOutputFromFinalSummary(workOrder, result);
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
      });
      result = recoverInvalidOutputFromFinalSummary(workOrder, result);
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
    const endedAt = Date.now();
    const completion = completeLoopSupervisorRun({
      workOrder,
      supervisorSession,
      startedAt,
      endedAt,
      result,
      backlog,
    });
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession,
      status: workOrderStateForResult(result),
      now: endedAt,
      resultStatus: result.status,
    });
    if (completion.retrySchedule || result.status === "invalid-output") {
      restoreLastFired(input.schedulerStore, previousLastFired, due.jobKey, due.scheduledAt);
    } else {
      input.schedulerStore.setLastFired(due.jobKey, due.scheduledAt);
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
    });
    ran++;
    if (result.status !== "completed") failed++;
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
    const availableSupervisorSessions =
      supervisorSessions.length === 0
        ? supervisorSessions
        : supervisorSessions.filter((session) => !active.supervisorSessions.has(session));
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
  };

  const skipDueTarget = (target: ResolvedDue, summary: string): void => {
    const endedAt = Date.now();
    const taskId = `loop:${target.due.jobKey}:${target.due.scheduledAt}`;
    taskLedger.expect({
      taskId,
      source: "loop-engineering",
      name: `${target.due.projectId} ${target.due.jobKind}`,
      scheduledAt: target.due.scheduledAt,
    });
    taskLedger.skip(taskId, { endedAt, summary });
    input.schedulerStore.setLastFired(target.due.jobKey, target.due.scheduledAt);
    log.info("loop engineering due target skipped by conflict planner", {
      data: {
        projectId: target.due.projectId,
        jobKey: target.due.jobKey,
        jobKind: target.due.jobKind,
        scheduledAt: new Date(target.due.scheduledAt).toISOString(),
        summary,
      },
    });
  };

  for (const due of scheduler.dueProjects) {
    const target = resolveDue(due);
    const runner = target.project?.runner ?? target.repository?.runner ?? target.workspace?.runner;
    if (runner?.kind === "agent-supervised") {
      supervisedBuffer.push(target);
      continue;
    }
    await flushSupervisedBuffer();
    await runSystemDue(target);
  }
  await flushSupervisedBuffer();

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
      ...workOrder.workspace.repositories.map((repository) => repository.path),
    ]);
  }
  return normalizeResourcePaths([workOrder.projectPath]);
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
        supervisorSessionNames: loopSupervisorSessionNames(
          deps.config.projectSessionPrefix,
          deps.config.loopEngineering.supervisor.poolSize,
        ),
        resetSupervisorBeforeWorkOrder: deps.config.loopEngineering.supervisor.resetBeforeWorkOrder,
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
      });
      log.info("loop engineering tick complete", { data: result });
    } catch (err) {
      log.error("loop engineering tick failed", { err });
    } finally {
      tickInFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), config.tickMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
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
    ...listUnfinishedLoopSupervisorWorkOrders(),
    ...listRecoverableFailedLoopSupervisorWorkOrders(),
  ];
  const schedulerStore = new LoopSchedulerStore();
  const taskLedger = new DailyTaskLedger();
  let checked = 0;
  let recovered = 0;
  let failed = 0;

  for (const record of unfinished) {
    const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
    if (!parsed.ok) continue;
    const project = systemGateProjectForRecoveredWorkOrder(config, record.workOrder);
    checked++;

    const recoveredResult: LoopSupervisedRunResult = {
      status: supervisorFinalStatusToRunStatus(parsed.summary.status),
      summary: parsed.summary,
      output: `recovered supervisor final summary from ${
        record.workOrder.finalSummaryPath ?? "work order state"
      }`,
    };
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

  return { checked, recovered, failed };
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
  return workOrder.projectId;
}

function runIdForDueProject(
  scheduledAt: number,
  projectId: string,
  jobKind:
    | "architecture"
    | "workspace-architecture"
    | "bug-fix"
    | "test-coverage"
    | "security-maintenance"
    | "harness-auto"
    | "opportunity-discovery"
    | "pull-request-review"
    | "repository-pull-request-review",
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
  if (jobKind === "repository-pull-request-review")
    return `${scheduledAt}-${projectId}-repo-pr-review`;
  return `${scheduledAt}-${projectId}-pr-review`;
}

function workspaceJobKind(
  jobKind:
    | "architecture"
    | "workspace-architecture"
    | "bug-fix"
    | "test-coverage"
    | "security-maintenance"
    | "harness-auto"
    | "opportunity-discovery"
    | "pull-request-review"
    | "repository-pull-request-review",
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
