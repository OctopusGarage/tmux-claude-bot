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
import { recoverInvalidOutputFromFinalSummary } from "../loop/final-summary-recovery.js";
import {
  runGitCommand,
  runShellCommand,
  runSupervisedSystemGateOutcome,
  supervisorRevisionFailures,
  systemGateProjectFromWorkOrder,
} from "../loop/service.js";
import {
  type LoopSupervisedRunResult,
  runLoopSupervisedProjectAsync,
  runLoopSupervisorRevisionAsync,
} from "../loop/supervised-runner.js";
import { completeLoopSupervisorRun } from "../loop/supervisor-completion.js";
import { loopSupervisorSessionNames, startLoopSupervisor } from "../loop/supervisor-session.js";
import {
  listUnfinishedLoopSupervisorWorkOrders,
  type UnfinishedLoopSupervisorWorkOrder,
  workOrderStateForResult,
  writeLoopSupervisorWorkOrderState,
} from "../loop/supervisor-state.js";
import { buildActiveDelegatedTaskWorkOrder, type LoopWorkOrder } from "../loop/work-order.js";
import { markImplementedOpportunitiesForCompletedDelegation } from "../opportunities/delegation-completion.js";
import { getPathBySession } from "../projects/sessionPathMap.js";

const log = createLogger("autopilot.delegated-task");
const DEFAULT_ACTIVE_DELEGATE_TIMEOUT_MS = 7_200_000;
const DEFAULT_REVISION_MAX_ATTEMPTS = 3;
export const DEFAULT_CONTEXT_DELEGATE_REQUIREMENT = [
  "Continue the current user-confirmed task from the target session context and repository state until it is genuinely complete.",
  "First inspect the live session, git status, recent commits, existing PRs, and any prior verification output to determine what remains.",
  "Do not expand scope or add unrelated features. If existing local changes or commits already satisfy part of the work, review them instead of redoing them.",
  "Before changing code, verify any suspected issue is real and actionable. After changing code, review the diff for regressions and run the relevant local verification, tests, coverage review for touched risk paths, and existing deterministic or agent-backed evals when justified.",
  "If the matched project policy enables PRs, create or update one coherent PR against the configured base, write a clear PR body, wait for required CI and mergeability gates, auto-merge only when configured and all gates pass, then switch the local worktree back to the configured branch and fast-forward it.",
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
  | { status: "blocked"; reason: string };

export type ActiveDelegatedTaskCancelResult =
  | {
      status: "cancelled";
      runId: string;
      projectId: string;
      supervisorSession: string;
    }
  | { status: "not-found"; reason: string };

type ActiveDelegatedTaskController = {
  workOrder: LoopWorkOrder;
  controller: AbortController;
};

const activeDelegatedTasks = new Map<string, ActiveDelegatedTaskController>();

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

export async function startActiveDelegatedTask(
  deps: HandlerDeps,
  input: { session: string; requirement: string; opportunityIds?: string[] },
): Promise<ActiveDelegatedTaskStartResult> {
  if (!deps.config.loopEngineering.supervisor.enabled) {
    return {
      status: "blocked",
      reason: "loop supervisor is disabled; set LOOP_SUPERVISOR_ENABLED=true",
    };
  }

  const projectPath = getPathBySession(input.session);
  if (projectPath === null) {
    return {
      status: "blocked",
      reason: `no project path is recorded for session "${input.session}"`,
    };
  }

  const conflict = findProjectAutomationConflict(projectPath);
  if (conflict !== null) {
    return {
      status: "blocked",
      reason: `project already has active automation: ${conflict.taskKind} ${conflict.runId} (${conflict.status})`,
    };
  }

  const reserved = listReservedLoopSupervisorWorkOrders();
  const candidates = selectSupervisorSessionCandidates(deps, reserved);
  if (candidates.length === 0) {
    return { status: "blocked", reason: "all loop supervisor sessions have active work" };
  }
  const supervisorSession = await ensureFirstAvailableSupervisor(deps, candidates);
  if (supervisorSession === null) {
    return {
      status: "blocked",
      reason: `failed to ensure loop supervisor sessions: ${candidates.join(", ")}`,
    };
  }

  const agent =
    (await deps.configResolver.detectAgentKind?.(input.session).catch(() => null)) ??
    deps.config.loopEngineering.supervisor.agent;
  const now = Date.now();
  const projectId = projectIdForSession(input.session, projectPath);
  const runId = `${now}-${projectId}-active-delegate`;
  const projectPolicy = findLoopProjectPolicy(deps, projectPath);
  const workOrder = buildActiveDelegatedTaskWorkOrder({
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
    ...(projectPolicy !== null ? { projectPolicy } : {}),
  });

  writeLoopSupervisorWorkOrderState({
    workOrder,
    supervisorSession,
    status: "dispatching",
    now,
  });
  log.info("active delegated task queued", {
    data: {
      runId,
      projectId,
      projectPath,
      session: input.session,
      supervisorSession,
      prEnabled: projectPolicy?.pullRequest.enabled ?? false,
      prBase: projectPolicy?.pullRequest.base,
      prSwitchBack: projectPolicy?.pullRequest.switchBack,
      prAutoMerge: projectPolicy?.pullRequest.autoMerge,
      opportunityIds: input.opportunityIds ?? [],
    },
  });

  const controller = new AbortController();
  activeDelegatedTasks.set(projectPath, { workOrder, controller });
  void runActiveDelegatedTaskInBackground(
    deps,
    workOrder,
    supervisorSession,
    now,
    controller.signal,
  )
    .catch((err) => {
      const message = normalizeError(err).message;
      log.error("active delegated task crashed", { err, data: { runId, projectId } });
      writeLoopSupervisorWorkOrderState({
        workOrder,
        supervisorSession,
        status: "failed",
        now: Date.now(),
        resultStatus: "dispatch-failed",
        revisionReasons: [message],
      });
    })
    .finally(() => {
      if (activeDelegatedTasks.get(projectPath)?.workOrder.id === workOrder.id) {
        activeDelegatedTasks.delete(projectPath);
      }
    });

  return {
    status: "queued",
    runId,
    projectId,
    supervisorSession,
    reportDir: workOrder.finalSummaryPath?.replace(/\/supervisor-final-summary\.json$/, "") ?? null,
  };
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
  const active = new Set(activeWork.map((record) => record.state.supervisorSession));
  const sessions = loopSupervisorSessionNames(
    deps.config.projectSessionPrefix,
    deps.config.loopEngineering.supervisor.poolSize,
  );
  return sessions.filter((session) => !active.has(session));
}

async function ensureFirstAvailableSupervisor(
  deps: HandlerDeps,
  candidates: string[],
): Promise<string | null> {
  for (const session of candidates) {
    if (await startLoopSupervisor(deps, undefined, session)) return session;
    log.warn("active delegated task skipped unavailable loop supervisor session", {
      data: { session },
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
  const dispatch = createLoopSupervisorTaskRunner(deps);
  let result = await runLoopSupervisedProjectAsync({
    workOrder,
    supervisorSession,
    timeoutMs: DEFAULT_ACTIVE_DELEGATE_TIMEOUT_MS,
    resetBeforeWorkOrder: deps.config.loopEngineering.supervisor.resetBeforeWorkOrder,
    cancelSignal,
    dispatch,
  });

  result = recoverInvalidOutputFromFinalSummary(workOrder, result);
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
    result = recoverInvalidOutputFromFinalSummary(workOrder, result);
    gate = runSupervisedSystemGateOutcome({
      project: systemGateProjectFromWorkOrder(workOrder),
      workOrder,
      result,
      runCommand: runShellCommand,
      runGit: runGitCommand,
    });
    revisionFailures = supervisorRevisionFailures(gate.failures);
  }

  finishActiveDelegatedTask(deps, workOrder, supervisorSession, startedAt, gate.result);
}

function finishActiveDelegatedTask(
  deps: HandlerDeps,
  workOrder: LoopWorkOrder,
  supervisorSession: string,
  startedAt: number,
  result: LoopSupervisedRunResult,
): void {
  const endedAt = Date.now();
  const completion = completeLoopSupervisorRun({
    workOrder,
    supervisorSession,
    startedAt,
    endedAt,
    result,
  });
  writeLoopSupervisorWorkOrderState({
    workOrder,
    supervisorSession,
    status: workOrderStateForResult(result),
    now: endedAt,
    resultStatus: result.status,
  });
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
  const summary =
    result.status === "completed"
      ? result.summary.actionsTaken.join("; ") || "completed"
      : "Active delegated task did not complete successfully.";
  void deps.notifications.notify({
    source: "autopilot-delegate",
    level: result.status === "completed" ? "info" : "error",
    session: workOrder.notificationSession ?? supervisorSession,
    title: `Delegated task ${result.status}`,
    body: [
      `Project: ${workOrder.projectName}`,
      `Run: ${workOrder.id}`,
      `Report: ${completion.report.markdownPath}`,
      `Summary: ${summary}`,
    ].join("\n"),
  });
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
        record.workOrder.projectPath === projectPath &&
        record.workOrder.task?.kind === "active-delegated-task",
    ) ?? null
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
