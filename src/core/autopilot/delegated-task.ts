import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import {
  findProjectAutomationConflict,
  listReservedLoopSupervisorWorkOrders,
} from "../automation/project-conflicts.js";
import type { HandlerDeps } from "../deps.js";
import { createLoopSupervisorTaskRunner } from "../loop/agent-queue.js";
import { type LoopProjectConfig, parseLoopConfigYaml } from "../loop/config.js";
import { prepareLoopExecutionWorktrees } from "../loop/execution-worktree.js";
import { recoverInvalidOutputFromFinalSummaryAsync } from "../loop/final-summary-recovery.js";
import {
  runGitCommand,
  runShellCommand,
  runSupervisedSystemGateOutcome,
  type SupervisedSystemGateOutcome,
  supervisorRevisionFailures,
  systemGateProjectFromWorkOrder,
  writeSupervisedSystemGateArtifact,
} from "../loop/service.js";
import {
  type LoopSupervisedRunResult,
  runLoopSupervisedProjectAsync,
  runLoopSupervisorRevisionAsync,
} from "../loop/supervised-runner.js";
import { completeLoopSupervisorRun } from "../loop/supervisor-completion.js";
import {
  leaseLoopSupervisorWorker,
  readLoopSupervisorWorkerLeaseState,
  releaseLoopSupervisorWorker,
  writeLoopSupervisorWorkerLeaseState,
} from "../loop/supervisor-pool.js";
import { loopSupervisorSessionNames, startLoopSupervisor } from "../loop/supervisor-session.js";
import {
  listUnfinishedLoopSupervisorWorkOrders,
  readLoopSupervisorWorkOrderRegistry,
  type UnfinishedLoopSupervisorWorkOrder,
  workOrderStateForResult,
  writeLoopSupervisorWorkOrderState,
} from "../loop/supervisor-state.js";
import {
  buildActiveDelegatedTaskWorkOrder,
  type LoopWorkOrder,
  type LoopWorktreeIsolationMode,
} from "../loop/work-order.js";
import { markImplementedOpportunitiesForCompletedDelegation } from "../opportunities/delegation-completion.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { cleanupWorkerSessionRecords } from "../recovery/worker-session-cleanup.js";
import { admitResourceWork } from "../resource-guardian/admission.js";
import { DailyTaskLedger } from "../tasks/task-ledger.js";

const log = createLogger("autopilot.delegated-task");
const DEFAULT_ACTIVE_DELEGATE_TIMEOUT_MS = 7_200_000;
const WORKER_STARTUP_GRACE_MS = 2 * 60_000;
const WORKER_STARTUP_PROBE_MS = 1_000;
const DEFAULT_REVISION_MAX_ATTEMPTS = 3;
export const DEFAULT_CONTEXT_DELEGATE_REQUIREMENT = [
  "Continue the current user-confirmed task from the target session context and repository state until it is genuinely complete.",
  "First inspect the live session, git status, recent commits, existing PRs, and any prior verification output to determine what remains.",
  "Do not expand scope or add unrelated features. If existing local changes or commits already satisfy part of the work, review them instead of redoing them.",
  "Before changing code, verify any suspected issue is real and actionable. After changing code, review the diff for regressions and run the relevant local verification, tests, coverage review for touched risk paths, and existing deterministic or agent-backed evals when justified.",
  "If the matched project policy enables PRs, create or update one coherent PR against the configured base, write a clear PR body, wait for required CI and mergeability gates, and auto-merge only when configured and all gates pass. In isolated execution, leave the worker on the WorkOrder branch: never checkout or rebase the shared base/switch-back branch and never mutate the original source worktree; the bot system owns source switch-back after acceptance.",
  "Keep logs and final summary precise: what was inspected, what changed, what was verified, PR or merge result, final branch, final worktree cleanliness, and any real blocker with evidence.",
].join(" ");

export type ActiveDelegatedTaskStartResult =
  | {
      status: "queued";
      runId: string;
      projectId: string;
      supervisorSession: string;
      reportDir: string | null;
    }
  | { status: "blocked"; reason: string; showQueue: boolean };

export type ActiveDelegateCompletionNotification = {
  level: "warning" | "error";
  title: string;
  summary: string;
};

export function formatActiveDelegateCompletion(input: {
  resultStatus: string;
  gateFailures: readonly string[];
}): ActiveDelegateCompletionNotification {
  if (input.resultStatus === "supervisor-failed" && input.gateFailures.length > 0) {
    return {
      level: "warning",
      title: "Delegated task completed; system acceptance failed",
      summary: `Supervisor completed the delegated task, but the system acceptance gate failed: ${input.gateFailures.join("; ")}.`,
    };
  }
  return {
    level: "error",
    title: `Delegated task ${input.resultStatus}`,
    summary: "Active delegated task did not complete successfully.",
  };
}

export type ActiveDelegatedTaskCancelResult =
  | {
      status: "cancelled";
      runId: string;
      projectId: string;
      supervisorSession: string;
    }
  | { status: "not-found"; reason: string };

export type ActiveDelegateQueueItem = {
  runId: string;
  projectId: string;
  taskKind: string;
  status: string;
  supervisorSession: string;
  updatedAt: number;
  runDir: string;
  cancellable: boolean;
};

type ActiveDelegatedTaskController = {
  workOrder: LoopWorkOrder;
  controller: AbortController;
};

const activeDelegatedTasks = new Map<string, ActiveDelegatedTaskController>();
const startingActiveDelegationProjects = new Set<string>();

export function parseDelegateRequirement(arg: string): string | null {
  const trimmed = arg.trim();
  const match = trimmed.match(/^delegate(?:\s+([\s\S]*))?$/i);
  if (match === null) return null;
  const requirement = match[1]?.trim();
  return requirement && requirement.length > 0 ? requirement : DEFAULT_CONTEXT_DELEGATE_REQUIREMENT;
}

export function formatActiveDelegateStart(result: ActiveDelegatedTaskStartResult): string {
  if (result.status === "blocked") return `Autopilot delegate blocked: ${result.reason}`;
  return [
    "Autopilot delegate queued.",
    `runId: ${result.runId}`,
    `project: ${result.projectId}`,
    `supervisor: ${result.supervisorSession}`,
    ...(result.reportDir !== null ? [`report: ${result.reportDir}`] : []),
  ].join("\n");
}

export function formatActiveDelegateCancel(result: ActiveDelegatedTaskCancelResult): string {
  if (result.status === "not-found") return `No active delegated task: ${result.reason}`;
  return [
    "Autopilot delegate cancellation requested.",
    `runId: ${result.runId}`,
    `project: ${result.projectId}`,
    `supervisor: ${result.supervisorSession}`,
  ].join("\n");
}

export function listActiveDelegateQueue(): ActiveDelegateQueueItem[] {
  return listReservedLoopSupervisorWorkOrders()
    .map((record) => {
      const taskKind = record.workOrder.task?.kind ?? "loop-engineering";
      return {
        runId: record.state.runId,
        projectId: record.state.projectId,
        taskKind,
        status: record.state.status,
        supervisorSession: record.state.supervisorSession,
        updatedAt: record.state.updatedAt,
        runDir: record.runDir,
        cancellable: taskKind === "active-delegated-task",
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function formatActiveDelegateQueue(items = listActiveDelegateQueue()): string {
  if (items.length === 0) return "No active loop supervisor work.";
  return [
    `Loop supervisor queue: ${items.length} active work item${items.length === 1 ? "" : "s"}`,
    "",
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.projectId} · ${item.taskKind} · ${item.status}`,
      `runId: ${item.runId}`,
      `supervisor: ${item.supervisorSession}`,
      `updated: ${new Date(item.updatedAt).toISOString()}`,
      `cancellable: ${item.cancellable ? "yes" : "no"}`,
      `report: ${item.runDir}`,
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();
}

export async function cancelActiveDelegatedTask(
  deps: HandlerDeps,
  input: { session: string },
): Promise<ActiveDelegatedTaskCancelResult> {
  const projectPath = getPathBySession(input.session);
  if (projectPath === null) {
    return {
      status: "not-found",
      reason: `no project path is recorded for session "${input.session}"`,
    };
  }
  const active = findActiveDelegatedTask(projectPath);
  if (active === null) {
    return {
      status: "not-found",
      reason: `no active delegated work for session "${input.session}"`,
    };
  }

  const controller = activeDelegatedTasks.get(projectPath);
  controller?.controller.abort("cancelled by user");
  writeLoopSupervisorWorkOrderState({
    workOrder: active.workOrder,
    supervisorSession: active.state.supervisorSession,
    status: "cancelled",
    now: Date.now(),
    resultStatus: "cancelled",
    revisionReasons: ["cancelled by user"],
  });
  await interruptSupervisor(deps, active.state.supervisorSession);
  return {
    status: "cancelled",
    runId: active.workOrder.id,
    projectId: active.workOrder.projectId,
    supervisorSession: active.state.supervisorSession,
  };
}

export function delegatedTaskCancellationReason(
  reason: "user" | "resource-pressure" = "user",
): string {
  return reason === "resource-pressure" ? "cancelled by resource pressure" : "cancelled by user";
}

export async function cancelActiveDelegatedTaskByRunId(
  deps: HandlerDeps,
  input: { runId: string; reason?: "user" | "resource-pressure" },
): Promise<ActiveDelegatedTaskCancelResult> {
  const active =
    listUnfinishedLoopSupervisorWorkOrders().find(
      (record) =>
        record.state.runId === input.runId &&
        record.workOrder.task?.kind === "active-delegated-task",
    ) ?? null;
  if (active === null) {
    return {
      status: "not-found",
      reason: `no cancellable active delegated work for run "${input.runId}"`,
    };
  }

  const controller =
    activeDelegatedTasks.get(active.workOrder.projectPath) ??
    activeDelegatedTasks.get(resolve(active.workOrder.projectPath));
  const cancellationReason = delegatedTaskCancellationReason(input.reason);
  controller?.controller.abort(cancellationReason);
  writeLoopSupervisorWorkOrderState({
    workOrder: active.workOrder,
    supervisorSession: active.state.supervisorSession,
    status: "cancelled",
    now: Date.now(),
    resultStatus: "cancelled",
    revisionReasons: [cancellationReason],
  });
  await interruptSupervisor(deps, active.state.supervisorSession);
  return {
    status: "cancelled",
    runId: active.workOrder.id,
    projectId: active.workOrder.projectId,
    supervisorSession: active.state.supervisorSession,
  };
}

export async function startActiveDelegatedTask(
  deps: HandlerDeps,
  input: {
    session: string;
    requirement: string;
    opportunityIds?: string[];
    worktreeIsolation?: LoopWorktreeIsolationMode;
    resourceTrigger?: "operator" | "background" | "resource-repair";
    resourceForce?: boolean;
    /** Internal durable idempotency identity for Resource Guardian repair only. */
    trustedRunId?: string;
  },
): Promise<ActiveDelegatedTaskStartResult> {
  if (!deps.config.loopEngineering.supervisor.enabled) {
    return {
      status: "blocked",
      reason: "loop supervisor is disabled; set LOOP_SUPERVISOR_ENABLED=true",
      showQueue: false,
    };
  }

  const admission = admitResourceWork({
    source: "autopilot-delegate",
    trigger: input.resourceTrigger ?? "operator",
    weight: "heavy",
    ...(input.resourceForce !== undefined ? { forced: input.resourceForce } : {}),
    now: Date.now(),
  });
  if (!admission.allowed) {
    return {
      status: "blocked",
      reason: `resource admission deferred: ${admission.reason}`,
      showQueue: false,
    };
  }

  const projectPath = getPathBySession(input.session);
  if (projectPath === null) {
    return {
      status: "blocked",
      reason: `no project path is recorded for session "${input.session}"`,
      showQueue: false,
    };
  }

  if (input.trustedRunId !== undefined) {
    if (
      input.resourceTrigger !== "resource-repair" ||
      !/^resource-repair-[A-Za-z0-9_-]+$/.test(input.trustedRunId)
    ) {
      return {
        status: "blocked",
        reason: "invalid trusted resource repair run id",
        showQueue: false,
      };
    }
    const existing = readLoopSupervisorWorkOrderRegistry().records.find(
      (record) =>
        record.workOrder.id === input.trustedRunId &&
        record.workOrder.task?.kind === "active-delegated-task" &&
        resolve(record.workOrder.projectPath) === resolve(projectPath),
    );
    if (existing !== undefined) {
      return {
        status: "queued",
        runId: existing.workOrder.id,
        projectId: existing.workOrder.projectId,
        supervisorSession: existing.state.supervisorSession,
        reportDir:
          existing.workOrder.finalSummaryPath?.replace(/\/supervisor-final-summary\.json$/, "") ??
          null,
      };
    }
  }

  const reservationKey = resolve(projectPath);
  if (startingActiveDelegationProjects.has(reservationKey)) {
    return {
      status: "blocked",
      reason: "project already has active automation: active delegated task is being started",
      showQueue: true,
    };
  }
  startingActiveDelegationProjects.add(reservationKey);

  try {
    const conflict = findProjectAutomationConflict(projectPath);
    if (conflict !== null) {
      return {
        status: "blocked",
        reason: `project already has active automation: ${conflict.taskKind} ${conflict.runId} (${conflict.status})`,
        showQueue: false,
      };
    }

    const reserved = listReservedLoopSupervisorWorkOrders();
    const allSupervisorSessions = loopSupervisorSessionNames(
      deps.config.projectSessionPrefix,
      deps.config.loopEngineering.supervisor.poolSize,
    );
    const candidates = selectSupervisorSessionCandidates(deps, reserved);
    const queueCandidates = candidates.length > 0 ? candidates : allSupervisorSessions;
    if (candidates.length === 0) {
      if (queueCandidates.length === 0) {
        return {
          status: "blocked",
          reason: "no loop supervisor sessions are configured",
          showQueue: true,
        };
      }
    }
    const agent =
      (await deps.configResolver.detectAgentKind?.(input.session).catch(() => null)) ??
      deps.config.loopEngineering.supervisor.agent;
    const now = Date.now();
    const projectId = projectIdForSession(input.session, projectPath);
    const runId = input.trustedRunId ?? `${now}-${projectId}-active-delegate`;
    const projectPolicy = findLoopProjectPolicy(deps, projectPath);
    let workOrder = buildActiveDelegatedTaskWorkOrder({
      session: input.session,
      projectId,
      projectName: basename(projectPath) || projectId,
      projectPath,
      agent,
      requirement: input.requirement,
      ...(input.opportunityIds !== undefined ? { opportunityIds: input.opportunityIds } : {}),
      scheduledAt: now,
      runId,
      timeoutMs: DEFAULT_ACTIVE_DELEGATE_TIMEOUT_MS,
      projectSessionPrefix: deps.config.projectSessionPrefix,
      ...(projectPolicy !== null ? { projectPolicy } : {}),
    });
    const preparationFailures: string[] = [];
    workOrder = prepareLoopExecutionWorktrees({
      workOrder,
      runGit: runGitCommand,
      defaultMode:
        input.worktreeIsolation ?? deps.config.loopEngineering.supervisor.worktreeIsolation,
      onPreparationFailure: (failure) => {
        preparationFailures.push(
          `${failure.repositoryId}: ${failure.reason}${
            failure.detail === undefined ? "" : `: ${failure.detail}`
          } (${failure.sourceWorktree})`,
        );
      },
    });
    if (preparationFailures.length > 0) {
      return {
        status: "blocked",
        reason: `execution worktree isolation failed: ${preparationFailures.join("; ")}`,
        showQueue: false,
      };
    }
    const supervisorSession = await reserveFirstAvailableSupervisor(
      deps,
      candidates,
      workOrder,
      now,
    );
    const queuedSupervisorSession = supervisorSession ?? queueCandidates[0];
    if (queuedSupervisorSession === undefined) {
      return {
        status: "blocked",
        reason: `failed to reserve loop supervisor sessions: ${candidates.join(", ")}`,
        showQueue: true,
      };
    }
    const assignedSupervisorSession = queuedSupervisorSession;
    if (
      supervisorSession === null &&
      !(await startLoopSupervisor(deps, undefined, assignedSupervisorSession))
    ) {
      return {
        status: "blocked",
        reason: `failed to ensure queued loop supervisor session ${assignedSupervisorSession}`,
        showQueue: true,
      };
    }

    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession: assignedSupervisorSession,
      status: supervisorSession === null ? "queued" : "dispatching",
      now,
    });
    const taskLedger = new DailyTaskLedger();
    const taskLedgerId = activeDelegatedTaskLedgerId(runId);
    taskLedger.expect({
      taskId: taskLedgerId,
      source: "autopilot-delegate",
      name: `${workOrder.projectName} active delegated task`,
      scheduledAt: now,
      summary: `Autopilot active delegation queued for ${workOrder.projectPath}.`,
    });
    taskLedger.start(taskLedgerId, now);
    log.info("active delegated task queued", {
      data: {
        runId,
        projectId,
        projectPath,
        session: input.session,
        supervisorSession: assignedSupervisorSession,
        prEnabled: projectPolicy?.pullRequest.enabled ?? false,
        prBase: projectPolicy?.pullRequest.base,
        prSwitchBack: projectPolicy?.pullRequest.switchBack,
        prAutoMerge: projectPolicy?.pullRequest.autoMerge,
        opportunityIds: input.opportunityIds ?? [],
      },
    });

    launchActiveDelegatedTask(deps, workOrder, assignedSupervisorSession, now);

    return {
      status: "queued",
      runId,
      projectId,
      supervisorSession: assignedSupervisorSession,
      reportDir:
        workOrder.finalSummaryPath?.replace(/\/supervisor-final-summary\.json$/, "") ?? null,
    };
  } finally {
    startingActiveDelegationProjects.delete(reservationKey);
  }
}

/** Resume durable active delegations after the bot process is restarted. */
export function resumeQueuedActiveDelegatedTasks(deps: HandlerDeps): number {
  if (!deps.config.loopEngineering.supervisor.enabled) return 0;
  const activeLeaseIds = new Set(
    readLoopSupervisorWorkerLeaseState()
      .leases.filter((lease) => lease.status === "active")
      .map((lease) => lease.workOrderId),
  );
  const queued = listUnfinishedLoopSupervisorWorkOrders().filter(
    (record) =>
      record.workOrder.task?.kind === "active-delegated-task" &&
      (record.state.status === "queued" || record.state.status === "dispatching") &&
      !activeLeaseIds.has(record.workOrder.id),
  );
  for (const record of queued) {
    launchActiveDelegatedTask(
      deps,
      record.workOrder,
      record.state.supervisorSession,
      record.state.updatedAt,
    );
  }
  if (queued.length > 0) {
    log.info("resumed queued active delegated tasks after startup", {
      data: { count: queued.length, runIds: queued.map((record) => record.workOrder.id) },
    });
  }
  return queued.length;
}

/** Reconcile worker leases before resuming delegations after a process restart. */
export async function reconcileAndResumeActiveDelegatedTasksAfterRestart(
  deps: HandlerDeps,
): Promise<number> {
  if (!deps.config.loopEngineering.supervisor.enabled) return 0;

  const leaseState = readLoopSupervisorWorkerLeaseState();
  const activeDelegated = new Map(
    listUnfinishedLoopSupervisorWorkOrders()
      .filter((record) => record.workOrder.task?.kind === "active-delegated-task")
      .map((record) => [record.workOrder.id, record]),
  );
  const now = Date.now();
  let orphaned = 0;
  for (const lease of leaseState.leases.filter((candidate) => candidate.status === "active")) {
    const record = activeDelegated.get(lease.workOrderId);
    if (record === undefined) continue;
    // The supervisor lease names the session that consumes this WorkOrder. The
    // WorkOrder's workerSession is a derived cleanup/resource identity and may
    // never have been created for queue-driven active delegations.
    if (
      await workerAgentIsRunningAfterStartupGrace(deps, record.workOrder.agent, lease.workerSession)
    ) {
      continue;
    }

    writeLoopSupervisorWorkOrderState({
      workOrder: record.workOrder,
      supervisorSession: record.state.supervisorSession,
      status: "failed",
      now,
      resultStatus: "invalid-output",
      revisionReasons: ["supervisor worker lease has no live worker session after restart"],
    });
    const taskLedger = new DailyTaskLedger();
    const taskLedgerId = activeDelegatedTaskLedgerId(record.workOrder.id);
    const ledgerRecord = taskLedger.listAll().find((task) => task.taskId === taskLedgerId);
    if (ledgerRecord !== undefined && ledgerRecord.status === "running") {
      taskLedger.fail(taskLedgerId, {
        endedAt: now,
        error: "orphaned-supervisor-worker",
        summary: "Recovered an active delegation whose worker session no longer exists.",
      });
    }
    writeLoopSupervisorWorkerLeaseState(
      releaseLoopSupervisorWorker({
        state: readLoopSupervisorWorkerLeaseState(),
        workOrderId: lease.workOrderId,
        result: "failure",
        now,
        retainFailureForMs:
          (record.workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) *
          60 *
          60 *
          1000,
      }),
    );
    orphaned++;
  }

  if (orphaned > 0) {
    log.warn("reconciled orphaned active delegated worker leases after startup", {
      data: { count: orphaned },
    });
  }
  return resumeQueuedActiveDelegatedTasks(deps);
}

async function workerAgentIsRunningAfterStartupGrace(
  deps: HandlerDeps,
  agent: LoopWorkOrder["agent"],
  workerSession: string,
): Promise<boolean> {
  const deadline = Date.now() + WORKER_STARTUP_GRACE_MS;
  for (;;) {
    if (!(await deps.bridge.hasSession(workerSession))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(WORKER_STARTUP_PROBE_MS, remaining)),
      );
      continue;
    }
    const agentRunning =
      agent === "codex"
        ? await deps.configResolver.isCodexRunning(workerSession)
        : await deps.configResolver.isClaudeRunning(workerSession);
    if (agentRunning) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WORKER_STARTUP_PROBE_MS, remaining)),
    );
  }
}

function launchActiveDelegatedTask(
  deps: HandlerDeps,
  workOrder: LoopWorkOrder,
  supervisorSession: string,
  startedAt: number,
): void {
  const projectPath = workOrder.projectPath;
  const controller = new AbortController();
  activeDelegatedTasks.set(projectPath, { workOrder, controller });
  void runActiveDelegatedTaskInBackground(
    deps,
    workOrder,
    supervisorSession,
    startedAt,
    controller.signal,
  )
    .catch(async (err) => {
      const message = normalizeError(err).message;
      log.error("active delegated task crashed", {
        err,
        data: { runId: workOrder.id, projectId: workOrder.projectId },
      });
      const endedAt = Date.now();
      const taskLedger = new DailyTaskLedger();
      const taskLedgerId = activeDelegatedTaskLedgerId(workOrder.id);
      if (
        taskLedger
          .listAll()
          .some((task) => task.taskId === taskLedgerId && task.status === "running")
      ) {
        taskLedger.fail(taskLedgerId, {
          endedAt,
          error: message,
          summary: "Active delegated task crashed before completion.",
        });
      }
      try {
        writeLoopSupervisorWorkOrderState({
          workOrder,
          supervisorSession,
          status: "failed",
          now: endedAt,
          resultStatus: "dispatch-failed",
          revisionReasons: [message],
        });
      } catch (stateError) {
        log.warn("failed to persist active delegated task failure state", { err: stateError });
      }
      if (workOrder.workerSession !== undefined) {
        try {
          await deps.bridge.killSession(workOrder.workerSession);
        } catch (cleanupError) {
          log.warn("failed to kill crashed active delegated worker", { err: cleanupError });
        }
        cleanupWorkerSessionRecords(workOrder.workerSession);
      }
    })
    .finally(() => {
      if (activeDelegatedTasks.get(projectPath)?.workOrder.id === workOrder.id) {
        activeDelegatedTasks.delete(projectPath);
      }
    });
}

function findLoopProjectPolicy(deps: HandlerDeps, projectPath: string): LoopProjectConfig | null {
  const configFile = deps.config.loopEngineering.configFile;
  if (configFile.trim() === "" || !existsSync(configFile)) return null;
  try {
    const config = parseLoopConfigYaml(readFileSync(configFile, "utf8"));
    const targetPath = resolve(projectPath);
    return config.projects.find((project) => resolve(project.path) === targetPath) ?? null;
  } catch (err) {
    log.warn("active delegated task could not read loop project policy", {
      err,
      data: { configFile, projectPath },
    });
    return null;
  }
}

function selectSupervisorSessionCandidates(
  deps: HandlerDeps,
  activeWork: UnfinishedLoopSupervisorWorkOrder[],
): string[] {
  const active = new Set([
    ...activeWork.map((record) => record.state.supervisorSession),
    ...readLoopSupervisorWorkerLeaseState()
      .leases.filter((lease) => lease.status === "active")
      .map((lease) => lease.workerSession),
  ]);
  const sessions = loopSupervisorSessionNames(
    deps.config.projectSessionPrefix,
    deps.config.loopEngineering.supervisor.poolSize,
  );
  return sessions.filter((session) => !active.has(session));
}

async function reserveFirstAvailableSupervisor(
  deps: HandlerDeps,
  candidates: string[],
  workOrder: LoopWorkOrder,
  now: number,
): Promise<string | null> {
  const retainFailureForMs =
    (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000;
  for (const session of candidates) {
    if (!(await startLoopSupervisor(deps, undefined, session))) {
      log.warn("active delegated task skipped unavailable loop supervisor session", {
        data: { session },
      });
      continue;
    }
    const leased = leaseLoopSupervisorWorker({
      state: readLoopSupervisorWorkerLeaseState(),
      supervisorSession: session,
      workOrder,
      now,
      retainFailureForMs,
    });
    writeLoopSupervisorWorkerLeaseState(leased.state);
    if (leased.status === "leased") return session;
    log.warn("active delegated task skipped leased loop supervisor session", {
      data: { session, reason: leased.reason },
    });
  }
  return null;
}

async function runActiveDelegatedTaskInBackground(
  deps: HandlerDeps,
  workOrder: LoopWorkOrder,
  supervisorSession: string,
  startedAt: number,
  cancelSignal: AbortSignal,
): Promise<void> {
  const dispatch = createLoopSupervisorTaskRunner(deps, { deferLeaseUntilConsumption: true });
  let result = await runLoopSupervisedProjectAsync({
    workOrder,
    supervisorSession,
    timeoutMs: DEFAULT_ACTIVE_DELEGATE_TIMEOUT_MS,
    resetBeforeWorkOrder: deps.config.loopEngineering.supervisor.resetBeforeWorkOrder,
    cancelSignal,
    dispatch,
  });

  result = await recoverInvalidOutputFromFinalSummaryAsync(workOrder, result);
  let gate = runSupervisedSystemGateOutcome({
    project: systemGateProjectFromWorkOrder(workOrder),
    workOrder,
    result,
    runCommand: runShellCommand,
    runGit: runGitCommand,
  });
  let revisionAttempt = 0;
  let revisionFailures = supervisorRevisionFailures(gate.failures);
  while (
    revisionFailures.length > 0 &&
    revisionAttempt < DEFAULT_REVISION_MAX_ATTEMPTS &&
    !cancelSignal.aborted
  ) {
    revisionAttempt += 1;
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession,
      status: "needs-revision",
      now: Date.now(),
      resultStatus: gate.result.status,
      revisionAttempt,
      revisionReasons: revisionFailures,
    });
    result = await runLoopSupervisorRevisionAsync({
      workOrder,
      supervisorSession,
      timeoutMs: DEFAULT_ACTIVE_DELEGATE_TIMEOUT_MS,
      dispatch,
      failures: revisionFailures,
      attempt: revisionAttempt,
      maxAttempts: DEFAULT_REVISION_MAX_ATTEMPTS,
      previousOutput: gate.result.output,
      cancelSignal,
    });
    result = await recoverInvalidOutputFromFinalSummaryAsync(workOrder, result);
    gate = runSupervisedSystemGateOutcome({
      project: systemGateProjectFromWorkOrder(workOrder),
      workOrder,
      result,
      runCommand: runShellCommand,
      runGit: runGitCommand,
    });
    revisionFailures = supervisorRevisionFailures(gate.failures);
  }

  await finishActiveDelegatedTask(deps, workOrder, supervisorSession, startedAt, gate);
}

async function finishActiveDelegatedTask(
  deps: HandlerDeps,
  workOrder: LoopWorkOrder,
  supervisorSession: string,
  startedAt: number,
  gate: SupervisedSystemGateOutcome,
): Promise<void> {
  const endedAt = Date.now();
  const result = gate.result;
  const completion = completeLoopSupervisorRun({
    workOrder,
    supervisorSession,
    startedAt,
    endedAt,
    result,
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
  const taskLedger = new DailyTaskLedger();
  const taskLedgerId = activeDelegatedTaskLedgerId(workOrder.id);
  if (result.status === "completed") {
    taskLedger.finish(taskLedgerId, {
      endedAt,
      summary: result.summary.actionsTaken.join("; ") || "completed",
      reportPath: completion.report.markdownPath,
    });
  } else {
    taskLedger.fail(taskLedgerId, {
      endedAt,
      error:
        gate.failures.join("; ") ||
        ("reason" in result ? result.reason : `active delegation ended with ${result.status}`),
      summary: "Active delegated task did not pass its final execution or system acceptance gate.",
      reportPath: completion.report.markdownPath,
    });
  }
  settleActiveDelegatedSupervisorLease(workOrder, result, endedAt);
  if (workOrder.workerSession !== undefined) {
    try {
      await deps.bridge.killSession(workOrder.workerSession);
      cleanupWorkerSessionRecords(workOrder.workerSession);
      log.info("active delegated task terminal worker session cleaned up", {
        data: { runId: workOrder.id, workerSession: workOrder.workerSession },
      });
    } catch (err) {
      log.warn("failed to clean up terminal active delegated worker session", {
        err,
        data: { runId: workOrder.id, workerSession: workOrder.workerSession },
      });
    }
  }
  const implementedOpportunityIds = markImplementedOpportunitiesForCompletedDelegation({
    runId: workOrder.id,
    resultStatus: result.status,
    ...(workOrder.relatedOpportunityIds !== undefined
      ? { opportunityIds: workOrder.relatedOpportunityIds }
      : {}),
    now: endedAt,
  });
  if (implementedOpportunityIds.length > 0) {
    log.info("active delegated task marked opportunities implemented", {
      data: { runId: workOrder.id, opportunityIds: implementedOpportunityIds },
    });
  }
  const completionNotification =
    result.status === "completed"
      ? {
          level: "info" as const,
          title: "Delegated task completed",
          summary: result.summary.actionsTaken.join("; ") || "completed",
        }
      : formatActiveDelegateCompletion({
          resultStatus: result.status,
          gateFailures: gate.failures,
        });
  void deps.notifications.notify({
    source: "autopilot-delegate",
    level: completionNotification.level,
    session: workOrder.notificationSession ?? supervisorSession,
    title: completionNotification.title,
    body: [
      `Project: ${workOrder.projectName}`,
      `Run: ${workOrder.id}`,
      `Report: ${completion.report.markdownPath}`,
      `Summary: ${completionNotification.summary}`,
    ].join("\n"),
  });
}

function activeDelegatedTaskLedgerId(runId: string): string {
  return `autopilot:${runId}`;
}

function settleActiveDelegatedSupervisorLease(
  workOrder: LoopWorkOrder,
  result: LoopSupervisedRunResult,
  now: number,
): void {
  const retainFailureForMs =
    (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 60 * 60 * 1000;
  writeLoopSupervisorWorkerLeaseState(
    releaseLoopSupervisorWorker({
      state: readLoopSupervisorWorkerLeaseState(),
      workOrderId: workOrder.id,
      result: result.status === "completed" ? "success" : "failure",
      now,
      retainFailureForMs,
    }),
  );
}

function projectIdForSession(session: string, projectPath: string): string {
  const base = basename(projectPath) || session;
  return sanitizeId(base);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function findActiveDelegatedTask(projectPath: string) {
  return (
    listUnfinishedLoopSupervisorWorkOrders().find(
      (record) =>
        workOrderMatchesProjectPath(record.workOrder, projectPath) &&
        record.workOrder.task?.kind === "active-delegated-task",
    ) ?? null
  );
}

function workOrderMatchesProjectPath(workOrder: LoopWorkOrder, projectPath: string): boolean {
  const target = resolve(projectPath);
  return (
    resolve(workOrder.projectPath) === target ||
    (workOrder.executionIsolation?.sourceWorktree !== undefined &&
      resolve(workOrder.executionIsolation.sourceWorktree) === target)
  );
}

async function interruptSupervisor(deps: HandlerDeps, supervisorSession: string): Promise<void> {
  try {
    await deps.agent.interrupt(supervisorSession);
  } catch (err) {
    log.warn("failed to interrupt delegated task supervisor via agent runner", {
      err,
      data: { supervisorSession },
    });
    try {
      await deps.bridge.sendRawKey("C-c", supervisorSession);
    } catch (fallbackErr) {
      log.warn("failed to interrupt delegated task supervisor via raw key", {
        err: fallbackErr,
        data: { supervisorSession },
      });
    }
  }
}
