import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { expandTilde } from "../../shared/utils/path.js";
import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import { parseLoopConfigYaml } from "../loop/config.js";
import type { NotificationGateway } from "../notifications/gateway.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";
import { buildDailyAuditRepairPrompt } from "../prompts/repair-prompts.js";
import { cleanupWorkerSessionRecords } from "../recovery/worker-session-cleanup.js";
import { nextFire } from "../scheduling/occurrence.js";
import {
  buildDailyTaskAuditNotification,
  runDailyTaskAudit,
  type ScheduledTaskDiscovery,
} from "./daily-audit.js";
import { reconcileDailyAuditRepairState } from "./daily-audit-repair-state.js";
import {
  reconcileDailyAuditRepairQueue,
  reconcileDailyAuditRunState,
} from "./daily-audit-run-state.js";
import { isBotOwnedRetryableRecoveryEvidence } from "./project-recovery.js";
import {
  createProjectRecoveryDelegator,
  dispatchProjectRecovery,
} from "./project-recovery-dispatch.js";
import {
  type ProjectRecoveryDispatch,
  type ProjectRecoveryPassResult,
  reconcileProjectRecoveryArtifacts,
  runProjectRecoveryPass,
} from "./project-recovery-service.js";
import { dispatchRecoveryQueue } from "./recovery-admission.js";
import { RepairCoordinator } from "./repair-coordinator.js";
import {
  discoverLaunchdScheduledTasks,
  discoverLoopEngineeringScheduledTasks,
} from "./task-discovery.js";
import {
  DailyTaskLedger,
  previousSingaporeDayWindow,
  type ScheduledTaskRecord,
  type TaskAuditItem,
  type TaskWindow,
} from "./task-ledger.js";
import { reconcileAutopilotDelegatedTasks } from "./task-reconciliation.js";

const log = createLogger("tasks.daily-audit-service");
const LAST_FIRED_KEY = "daily-task-audit";
const FIRST_TICK_LOOKBACK_MS = 36 * 60 * 60_000;
let dailyTaskAuditTickInFlight = false;

export type DailyTaskAuditServiceTickResult =
  | {
      fired: true;
      scheduledAt: number;
      failures: number;
      repairDispatch: string;
      projectRecovery: string;
      notificationStatus: "sent" | "partial" | "failed" | "suppressed";
    }
  | { fired: false; reason: "disabled" | "not-due" | "invalid-schedule" | "in-progress" };

export type DailyTaskRepairDispatch = (input: {
  repoPath: string;
  repairBranch: string;
  items: TaskAuditItem[];
}) => Promise<DailyTaskRepairDispatchResult | undefined>;

export type DailyTaskRepairDispatchResult =
  | { status: "queued"; detail: string; runId?: string }
  | { status: "blocked"; detail: string };

export class DailyTaskAuditStore {
  private readonly fired = new JsonMapStore<number>("daily_task_audit_lastfired.json");

  getLastFired(): number | undefined {
    return this.fired.get(LAST_FIRED_KEY);
  }

  setLastFired(value: number): void {
    this.fired.set(LAST_FIRED_KEY, value);
  }
}

export type DailyTaskAuditServiceTickInput = {
  now: number;
  config: AppConfig["taskAudit"];
  notifications: NotificationGateway;
  ledger?: DailyTaskLedger;
  coordinator?: RepairCoordinator;
  store?: DailyTaskAuditStore;
  dispatchRepair?: DailyTaskRepairDispatch;
  dispatchProjectRecovery?: ProjectRecoveryDispatch;
  discover?: ScheduledTaskDiscovery;
  loopConfigFile?: string;
  reconcile?: () => Promise<void> | void;
  force?: boolean;
  skipScheduledAudit?: boolean;
};

export async function runDailyTaskAuditServiceTick(
  input: DailyTaskAuditServiceTickInput,
): Promise<DailyTaskAuditServiceTickResult> {
  if (dailyTaskAuditTickInFlight) return { fired: false, reason: "in-progress" };
  dailyTaskAuditTickInFlight = true;
  try {
    return await runDailyTaskAuditServiceTickInternal(input);
  } finally {
    dailyTaskAuditTickInFlight = false;
  }
}

async function runDailyTaskAuditServiceTickInternal(
  input: DailyTaskAuditServiceTickInput,
): Promise<DailyTaskAuditServiceTickResult> {
  if (!input.config.enabled || input.config.tickMs === 0)
    return { fired: false, reason: "disabled" };
  await input.reconcile?.();
  const store = input.store ?? new DailyTaskAuditStore();
  const ledger = input.ledger ?? new DailyTaskLedger();
  const coordinator = input.coordinator ?? new RepairCoordinator();
  const repoPath = input.config.repoPath.trim() || process.cwd();
  const reopenedSelfHealSweeps = ledger.reconcileDeferredSystemSelfHealSweeps(input.now);
  if (reopenedSelfHealSweeps > 0) {
    log.warn("reopened legacy deferred system self-heal sweeps", {
      data: { count: reopenedSelfHealSweeps },
    });
  }
  const staleAudits = reconcileDailyAuditRunState({
    ledger,
    coordinator,
    now: input.now,
    repoPath,
    reconcileRepairState: reconcileDailyAuditRepairState,
  });
  if (staleAudits > 0) {
    log.warn("reconciled stale daily audit ledger entries", {
      data: { count: staleAudits },
    });
  }
  const projectRecovery = await runConfiguredProjectRecovery({
    configFile: input.loopConfigFile,
    now: input.now,
    ledger,
    coordinator,
    dispatch: input.dispatchProjectRecovery,
  });
  reconcileDailyAuditRepairQueue({ ledger, coordinator, now: input.now });
  if (input.skipScheduledAudit) {
    if (input.config.autoRepair && input.dispatchRepair !== undefined) {
      await dispatchRepairQueue({ coordinator, ledger, input, repoPath });
    }
    return { fired: false, reason: "not-due" };
  }
  const scheduledAt = input.force
    ? input.now
    : dueScheduledAt(input.config.schedule, store, input.now);
  if (typeof scheduledAt !== "number") {
    if (input.config.autoRepair && input.dispatchRepair !== undefined) {
      await dispatchRepairQueue({ coordinator, ledger, input, repoPath });
    }
    return { fired: false, reason: scheduledAt };
  }
  const taskId = `daily-audit:${scheduledAt}`;
  recordDailyAuditSelfFindings({
    ledger,
    window: previousSingaporeDayWindow(input.now),
    now: input.now,
  });
  ledger.expect({
    taskId,
    source: "daily-audit",
    name: "Daily scheduled task audit",
    scheduledAt,
  });
  ledger.start(taskId, input.now);
  const result = await runDailyTaskAudit({
    now: input.now,
    ledger,
    discover:
      input.discover ??
      ((request) => [
        ...discoverLaunchdScheduledTasks({
          ...request,
          includeLabel: isBotOwnedLaunchdLabel,
        }),
        ...discoverLoopEngineeringScheduledTasks({
          ...request,
          ...(input.loopConfigFile !== undefined ? { configFile: input.loopConfigFile } : {}),
        }),
      ]),
  });
  for (const item of result.repairCandidates.filter(
    (candidate) => !isProjectRecoveryOwnedSource(candidate.source),
  )) {
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: repoPath,
      source: item.source,
      taskFamily: item.name,
      fingerprint: item.failureKind ?? item.error ?? item.summary ?? "unknown",
      taskId: item.taskId,
      ...(item.summary === undefined ? {} : { summary: item.summary }),
      priority: 100,
      now: input.now,
    });
  }
  let repairDispatch = "not-needed";
  if (input.config.autoRepair) {
    repairDispatch =
      input.dispatchRepair === undefined
        ? "unavailable"
        : await dispatchRepairQueue({ coordinator, ledger, input, repoPath });
  }
  const notificationResult = await input.notifications.notify(
    buildDailyTaskAuditNotification({
      summary: result.summary,
      repairCandidates: result.repairCandidates,
      channel: input.config.channel,
      repairDispatch: appendProjectRecoveryDispatch(repairDispatch, projectRecovery),
    }),
  );
  const notificationLog = {
    scheduledAt,
    status: notificationResult.status,
    deliveries: notificationResult.deliveries,
  };
  if (notificationResult.status === "sent" || notificationResult.status === "suppressed") {
    log.info(
      notificationResult.status === "sent"
        ? "daily task audit final notification sent"
        : "daily task audit final notification suppressed by policy",
      { data: notificationLog },
    );
  } else {
    log.warn("daily task audit final notification incomplete", { data: notificationLog });
  }
  if (notificationResult.status === "failed") {
    const error = `notification failed: ${notificationResult.deliveries
      .map((delivery) => `${delivery.channel}: ${delivery.error ?? "unknown error"}`)
      .join("; ")}`;
    ledger.fail(taskId, {
      endedAt: input.now,
      error,
      summary: auditRunSummary({
        failures: result.repairCandidates.length,
        repairDispatch,
        notificationStatus: notificationResult.status,
      }),
    });
    return {
      fired: true,
      scheduledAt,
      failures: result.repairCandidates.length,
      repairDispatch,
      projectRecovery: renderProjectRecoverySummary(projectRecovery),
      notificationStatus: notificationResult.status,
    };
  }
  ledger.finish(taskId, {
    endedAt: input.now,
    summary: auditRunSummary({
      failures: result.repairCandidates.length,
      repairDispatch,
      notificationStatus: notificationResult.status,
    }),
  });
  store.setLastFired(scheduledAt);
  return {
    fired: true,
    scheduledAt,
    failures: result.repairCandidates.length,
    repairDispatch: appendProjectRecoveryDispatch(repairDispatch, projectRecovery),
    projectRecovery: renderProjectRecoverySummary(projectRecovery),
    notificationStatus: notificationResult.status,
  };
}

async function dispatchRepairQueue(input: {
  coordinator: RepairCoordinator;
  ledger: DailyTaskLedger;
  input: Parameters<typeof runDailyTaskAuditServiceTick>[0];
  repoPath: string;
}): Promise<string> {
  if (input.input.dispatchRepair === undefined) return "unavailable";
  const leaseId = `daily-audit-repair:${input.input.now}`;
  const admission = await dispatchRecoveryQueue({
    coordinator: input.coordinator,
    now: input.input.now,
    leaseId,
    limit: 8,
    projectId: "tmux-claude-bot",
    // Project-recovery records have their own admission path above. Letting the
    // generic repair dispatcher claim them creates a second recovery loop that
    // can redispatch the same historical delegation after it already finished.
    excludeSources: [
      "runtime-guardian",
      "project-recovery",
      "loop-engineering",
      "autopilot-delegate",
    ],
    resolve: (claimed) =>
      claimed.flatMap((queueRecord) =>
        queueRecord.linkedTaskIds.flatMap((taskId) => {
          const record = input.ledger.listAll().find((candidate) => candidate.taskId === taskId);
          if (record === undefined) return [];
          return [
            record.status === "expected"
              ? ({ ...record, status: "missing" } as TaskAuditItem)
              : (record as TaskAuditItem),
          ];
        }),
      ),
    dispatch: async (items) =>
      input.input.dispatchRepair?.({
        repoPath: input.repoPath,
        repairBranch: input.input.config.repairBranch,
        items: [...items],
      }),
    onQueued: (claimed, result) => {
      for (const record of claimed) {
        if (result?.runId !== undefined)
          input.coordinator.linkTaskIds(record.id, [`autopilot:${result.runId}`], input.input.now);
        for (const taskId of record.linkedTaskIds) {
          input.ledger.markRepairStatus(taskId, {
            repairStatus: "running",
            updatedAt: input.input.now,
            summary: appendRepairSummary(
              input.ledger.listAll().find((candidate) => candidate.taskId === taskId)?.summary,
              "Repair Coordinator delegated this item.",
            ),
          });
        }
      }
    },
  });
  return admission.disposition === "not-needed"
    ? "not-needed"
    : admission.detail === "dispatch failed"
      ? "failed"
      : `${admission.disposition} - ${admission.detail}`;
}

function isProjectRecoveryOwnedSource(source: string): boolean {
  return source === "loop-engineering" || source === "autopilot-delegate";
}

function dueScheduledAt(
  schedule: string,
  store: DailyTaskAuditStore,
  now: number,
): number | "invalid-schedule" | "not-due" {
  const last = store.getLastFired();
  const scheduled = latestDueFire(schedule, last ?? now - FIRST_TICK_LOOKBACK_MS, now);
  return scheduled.kind === "due" ? scheduled.scheduledAt : scheduled.kind;
}

function latestDueFire(
  schedule: string,
  after: number,
  now: number,
): { kind: "due"; scheduledAt: number } | { kind: "invalid-schedule" | "not-due" } {
  let cursor = after;
  let latest: number | null = null;
  for (;;) {
    const fireAt = nextFire({ kind: "cron", cron: schedule }, cursor);
    if (fireAt === null) {
      return latest === null ? { kind: "invalid-schedule" } : { kind: "due", scheduledAt: latest };
    }
    if (fireAt > now) {
      return latest === null ? { kind: "not-due" } : { kind: "due", scheduledAt: latest };
    }
    latest = fireAt;
    cursor = fireAt;
  }
}

export function startDailyTaskAudit(deps: HandlerDeps): () => void {
  const config = deps.config.taskAudit;
  if (!config.enabled || config.tickMs === 0) {
    log.info("daily task audit disabled");
    return () => {};
  }
  const tick = (): void => {
    void runDailyTaskAuditServiceTick({
      now: Date.now(),
      config,
      notifications: deps.notifications,
      dispatchRepair: (request) => dispatchDailyTaskRepair(deps, request),
      dispatchProjectRecovery: (request) =>
        dispatchProjectRecovery(request, {
          projectSessionPrefix: deps.config.projectSessionPrefix,
          worktreeIsolation:
            deps.config.loopEngineering.supervisor.worktreeIsolation === "source"
              ? "source"
              : "isolated",
          delegate: createProjectRecoveryDelegator(deps),
        }),
      loopConfigFile: deps.config.loopEngineering.configFile,
      reconcile: async () => {
        await reconcileAutopilotDelegatedTasks({
          cleanupWorkerSession: async (session) => {
            await deps.bridge.killSession(session);
            cleanupWorkerSessionRecords(session);
          },
        });
      },
    }).catch((err) => log.warn("daily task audit tick failed", { err }));
  };
  const timer = setInterval(tick, config.tickMs);
  (timer as { unref?: () => void }).unref?.();
  void tick();
  return () => clearInterval(timer);
}

async function runConfiguredProjectRecovery(input: {
  configFile: string | undefined;
  now: number;
  ledger: DailyTaskLedger;
  coordinator: RepairCoordinator;
  dispatch: ProjectRecoveryDispatch | undefined;
}): Promise<ProjectRecoveryPassResult> {
  const empty: ProjectRecoveryPassResult = {
    classified: 0,
    enqueued: 0,
    dispatched: 0,
    waitingExternal: 0,
    ownerDecision: 0,
    superseded: 0,
    unconfigured: 0,
    deadLetter: 0,
    deferred: 0,
  };
  if (input.configFile === undefined || input.configFile.trim() === "") return empty;
  let config: ReturnType<typeof parseLoopConfigYaml>;
  try {
    config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
  } catch (err) {
    log.warn("project recovery skipped because Loop config could not be loaded", { err });
    return empty;
  }
  await reconcileProjectRecoveryArtifacts({
    now: input.now,
    records: input.ledger.listAll(),
    coordinator: input.coordinator,
    updateRepairStatus: (taskId, repairStatus, summary) => {
      input.ledger.markRepairStatus(taskId, { repairStatus, updatedAt: input.now, summary });
    },
  });
  const records = input.ledger
    .listAll()
    .filter(
      (record): record is ScheduledTaskRecord & { repairStatus: "pending" | "blocked" } =>
        (record.repairStatus === "pending" || shouldReconsiderBlockedRecovery(record)) &&
        (record.source === "loop-engineering" || record.source === "autopilot-delegate") &&
        ["failed", "missing", "running-timeout"].includes(record.status),
    );
  return runProjectRecoveryPass({
    now: input.now,
    records,
    config: {
      projects: config.projects,
      repositories: config.prReview.repositories,
      workspaces: config.workspaces,
    },
    coordinator: input.coordinator,
    ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
    canonicalize: canonicalizeRecoveryPath,
    verifyProjectPath: verifyRecoveryProjectPath,
    updateRepairStatus: (taskId, repairStatus, summary) => {
      input.ledger.markRepairStatus(taskId, {
        repairStatus,
        updatedAt: input.now,
        summary,
      });
    },
  });
}

function canonicalizeRecoveryPath(path: string): string {
  return resolve(expandTilde(path));
}

function verifyRecoveryProjectPath(path: string): boolean {
  try {
    const topLevel = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return resolve(topLevel) === canonicalizeRecoveryPath(path);
  } catch {
    return false;
  }
}

function shouldReconsiderBlockedRecovery(record: ScheduledTaskRecord): boolean {
  if (record.repairStatus !== "blocked") return false;
  const summary = record.summary?.toLowerCase() ?? "";
  if (isBotOwnedRetryableRecoveryEvidence(summary)) return true;
  if (summary.includes("no retryable project repair remains")) return false;
  if (summary.includes("recovery classification: recovery attempt limit reached")) return false;
  if (summary.includes("recovery classification: dead-letter")) return false;
  if (
    summary.includes("recovery classification: needs-owner-decision") &&
    !isRecoverableConfiguredTargetSummary(summary)
  )
    return false;
  if (
    summary.includes("configured project is unavailable or ambiguous") &&
    !isRecoverableConfiguredTargetSummary(summary)
  )
    return false;
  return true;
}

function isRecoverableConfiguredTargetSummary(summary: string): boolean {
  return (
    summary.includes("can be retried") ||
    summary.includes("invalid-final-summary") ||
    summary.includes("invalid final summary") ||
    summary.includes("incomplete recovery") ||
    isBotOwnedRetryableRecoveryEvidence(summary)
  );
}

function appendProjectRecoveryDispatch(
  repairDispatch: string,
  projectRecovery: ProjectRecoveryPassResult,
): string {
  return `${repairDispatch} · project-recovery=${renderProjectRecoverySummary(projectRecovery)}`;
}

function renderProjectRecoverySummary(result: ProjectRecoveryPassResult): string {
  if (result.classified === 0) return "not-needed";
  return [
    `classified=${result.classified}`,
    `queued=${result.enqueued}`,
    `dispatched=${result.dispatched}`,
    `deferred=${result.deferred}`,
    `external-wait=${result.waitingExternal}`,
    `owner-decision=${result.ownerDecision + result.unconfigured}`,
    `dead-letter=${result.deadLetter}`,
  ].join(" ");
}

function isBotOwnedLaunchdLabel(label: string): boolean {
  return label === "com.octopusgarage.tmux-claude-bot";
}

export async function dispatchDailyTaskRepair(
  deps: HandlerDeps,
  request: Parameters<DailyTaskRepairDispatch>[0],
): Promise<DailyTaskRepairDispatchResult> {
  if (!deps.config.loopEngineering.supervisor.enabled) {
    log.warn("daily task audit auto repair skipped because loop supervisor is disabled");
    return { status: "blocked", detail: "loop supervisor is disabled" };
  }
  const session = sessionNameFromPath(request.repoPath, deps.config.projectSessionPrefix);
  setPathForSession(session, request.repoPath);
  const prompt = buildDailyAuditRepairPrompt(request);
  const result = await startActiveDelegatedTask(deps, {
    session,
    requirement: prompt,
    worktreeIsolation: deps.config.taskAudit.repairWorktreeIsolation,
    resourceTrigger: "background",
  });
  if (result.status === "blocked") {
    const ctx = { data: { reason: result.reason } };
    if (isTransientRepairAdmissionDeferral(result.reason)) {
      log.debug("daily task audit auto repair could not be delegated", ctx);
    } else {
      log.warn("daily task audit auto repair could not be delegated", ctx);
    }
    return { status: "blocked", detail: result.reason };
  }
  return {
    status: "queued",
    runId: result.runId,
    detail: `runId=${result.runId} project=${result.projectId} supervisor=${result.supervisorSession}`,
  };
}

function isTransientRepairAdmissionDeferral(detail: string): boolean {
  return /^(automation admission deferred:|project already has active automation:|supervisor .*busy|supervisor .*lease|queue full|no available)/i.test(
    detail,
  );
}

function appendRepairSummary(current: string | undefined, addition: string): string {
  if (current === undefined || current.trim().length === 0) return addition;
  return `${current}\n${addition}`;
}

function auditRunSummary(input: {
  failures: number;
  repairDispatch: string;
  notificationStatus: string;
}): string {
  return `failures=${input.failures} repair-dispatch=${input.repairDispatch} notification=${input.notificationStatus}`;
}

function recordDailyAuditSelfFindings(input: {
  ledger: DailyTaskLedger;
  window: TaskWindow;
  now: number;
}): void {
  const records = input.ledger.listForWindow(input.window);
  const existingSelfRecords = new Map(
    records
      .filter((record) => record.taskId.startsWith("daily-audit:self:"))
      .map((record) => [record.taskId, record]),
  );
  for (const record of records) {
    const issue = dailyAuditSelfIssue(record);
    if (issue === null) continue;
    const taskId = `daily-audit:self:${record.scheduledAt}`;
    const existing = existingSelfRecords.get(taskId);
    if (existing?.repairStatus === "running" || isClosedSelfRepairStatus(existing?.repairStatus)) {
      continue;
    }
    input.ledger.expect({
      taskId,
      source: "daily-audit",
      name: "Daily task audit self-check",
      scheduledAt: record.scheduledAt,
      summary: `Self-check for ${record.taskId}.`,
    });
    input.ledger.fail(taskId, {
      endedAt: input.now,
      error: issue,
      summary: `Daily Task Audit self-check found previous audit issue: ${issue}`,
    });
  }
}

function dailyAuditSelfIssue(record: ScheduledTaskRecord): string | null {
  if (record.source !== "daily-audit") return null;
  if (record.taskId.startsWith("daily-audit:self:")) return null;
  if (
    record.status === "failed" ||
    record.status === "running" ||
    record.status === "running-timeout"
  ) {
    return `previous audit status=${record.status}${record.error ? ` error=${record.error}` : ""}`;
  }
  const summary = record.summary ?? "";
  const repairDispatch = summary.match(/\brepair-dispatch=([^\s]+)/)?.[1];
  if (
    repairDispatch === "failed" ||
    repairDispatch === "unavailable" ||
    repairDispatch === "blocked"
  ) {
    return `previous audit repair-dispatch=${repairDispatch}`;
  }
  const notification = summary.match(/\bnotification=([^\s]+)/)?.[1];
  if (notification === "partial" || notification === "failed") {
    return `previous audit notification=${notification}`;
  }
  return null;
}

function isClosedSelfRepairStatus(status: ScheduledTaskRecord["repairStatus"]): boolean {
  return ["fixed", "not-needed", "blocked", "superseded", "not-reproducible"].includes(
    status ?? "pending",
  );
}
