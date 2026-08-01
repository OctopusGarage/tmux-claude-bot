import type { AppConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import type { NotificationGateway } from "../notifications/gateway.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";
import { nextFire } from "../scheduler/scheduling.js";
import {
  buildDailyTaskAuditNotification,
  runDailyTaskAudit,
  type ScheduledTaskDiscovery,
} from "./daily-audit.js";
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
import { buildDailyAuditRepairPrompt } from "./task-repair.js";

const log = createLogger("tasks.daily-audit-service");
const LAST_FIRED_KEY = "daily-task-audit";
const FIRST_TICK_LOOKBACK_MS = 36 * 60 * 60_000;

export type DailyTaskAuditServiceTickResult =
  | {
      fired: true;
      scheduledAt: number;
      failures: number;
      repairDispatch: string;
      notificationStatus: "sent" | "partial" | "failed";
    }
  | { fired: false; reason: "disabled" | "not-due" | "invalid-schedule" };

export type DailyTaskRepairDispatch = (input: {
  repoPath: string;
  repairBranch: string;
  items: TaskAuditItem[];
}) => Promise<DailyTaskRepairDispatchResult | undefined>;

export type DailyTaskRepairDispatchResult =
  | { status: "queued"; detail: string }
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

export async function runDailyTaskAuditServiceTick(input: {
  now: number;
  config: AppConfig["taskAudit"];
  notifications: NotificationGateway;
  ledger?: DailyTaskLedger;
  store?: DailyTaskAuditStore;
  dispatchRepair?: DailyTaskRepairDispatch;
  discover?: ScheduledTaskDiscovery;
  loopConfigFile?: string;
  force?: boolean;
}): Promise<DailyTaskAuditServiceTickResult> {
  if (!input.config.enabled || input.config.tickMs === 0)
    return { fired: false, reason: "disabled" };
  const store = input.store ?? new DailyTaskAuditStore();
  const scheduledAt = input.force
    ? input.now
    : dueScheduledAt(input.config.schedule, store, input.now);
  if (typeof scheduledAt !== "number") return { fired: false, reason: scheduledAt };
  const ledger = input.ledger ?? new DailyTaskLedger();
  const taskId = `daily-audit:${scheduledAt}`;
  recordDailyAuditSelfFindings({
    ledger,
    window: previousSingaporeDayWindow(input.now),
    now: input.now,
  });
  const repoPath = input.config.repoPath.trim() || process.cwd();
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
  let repairDispatch = "not-needed";
  if (input.config.autoRepair && result.repairCandidates.length > 0) {
    if (input.dispatchRepair === undefined) {
      repairDispatch = "unavailable";
    } else {
      try {
        const dispatchResult = await input.dispatchRepair({
          repoPath,
          repairBranch: input.config.repairBranch,
          items: result.repairCandidates,
        });
        if (dispatchResult?.status === "blocked") {
          repairDispatch = `blocked - ${dispatchResult.detail}`;
        } else {
          repairDispatch =
            dispatchResult?.detail === undefined ? "queued" : `queued - ${dispatchResult.detail}`;
          for (const item of result.repairCandidates) {
            ledger.markRepairStatus(item.taskId, {
              repairStatus: "running",
              updatedAt: input.now,
              summary: appendRepairSummary(item.summary, "Daily audit auto-repair delegated."),
            });
          }
        }
      } catch (err) {
        repairDispatch = "failed";
        log.warn("daily task audit auto repair dispatch failed", { err });
      }
    }
  }
  const notificationResult = await input.notifications.notify(
    buildDailyTaskAuditNotification({
      summary: result.summary,
      repairCandidates: result.repairCandidates,
      channel: input.config.channel,
      repairDispatch,
    }),
  );
  const notificationLog = {
    scheduledAt,
    status: notificationResult.status,
    deliveries: notificationResult.deliveries,
  };
  if (notificationResult.status === "sent") {
    log.info("daily task audit final notification sent", { data: notificationLog });
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
    repairDispatch,
    notificationStatus: notificationResult.status,
  };
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
      loopConfigFile: deps.config.loopEngineering.configFile,
    }).catch((err) => log.warn("daily task audit tick failed", { err }));
  };
  const timer = setInterval(tick, config.tickMs);
  (timer as { unref?: () => void }).unref?.();
  void tick();
  return () => clearInterval(timer);
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
  });
  if (result.status === "blocked") {
    log.warn("daily task audit auto repair could not be delegated", {
      data: { reason: result.reason },
    });
    return { status: "blocked", detail: result.reason };
  }
  return {
    status: "queued",
    detail: `runId=${result.runId} project=${result.projectId} supervisor=${result.supervisorSession}`,
  };
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
