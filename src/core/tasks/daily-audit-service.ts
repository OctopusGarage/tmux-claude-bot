import type { AppConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { newMessageId } from "../command/enqueue.js";
import type { HandlerDeps } from "../deps.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import { loopSupervisorSessionNames, startLoopSupervisor } from "../loop/supervisor-session.js";
import type { NotificationGateway } from "../notifications/gateway.js";
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
import { DailyTaskLedger, type TaskAuditItem } from "./task-ledger.js";
import { buildDailyAuditRepairPrompt } from "./task-repair.js";

const log = createLogger("tasks.daily-audit-service");
const LAST_FIRED_KEY = "daily-task-audit";
const FIRST_TICK_LOOKBACK_MS = 36 * 60 * 60_000;

export type DailyTaskAuditServiceTickResult =
  | { fired: true; scheduledAt: number; failures: number }
  | { fired: false; reason: "disabled" | "not-due" | "invalid-schedule" };

export type DailyTaskRepairDispatch = (input: {
  repoPath: string;
  repairBranch: string;
  items: TaskAuditItem[];
}) => Promise<void>;

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
}): Promise<DailyTaskAuditServiceTickResult> {
  if (!input.config.enabled || input.config.tickMs === 0)
    return { fired: false, reason: "disabled" };
  const store = input.store ?? new DailyTaskAuditStore();
  const last = store.getLastFired();
  const scheduled = latestDueFire(
    input.config.schedule,
    last ?? input.now - FIRST_TICK_LOOKBACK_MS,
    input.now,
  );
  if (scheduled.kind !== "due") return { fired: false, reason: scheduled.kind };
  const scheduledAt = scheduled.scheduledAt;
  const ledger = input.ledger ?? new DailyTaskLedger();
  const taskId = `daily-audit:${scheduledAt}`;
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
        await input.dispatchRepair({
          repoPath: process.cwd(),
          repairBranch: input.config.repairBranch,
          items: result.repairCandidates,
        });
        repairDispatch = "queued";
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
      endedAt: Date.now(),
      error,
      summary: `failures=${result.repairCandidates.length} repair-dispatch=${repairDispatch}`,
    });
    return { fired: true, scheduledAt, failures: result.repairCandidates.length };
  }
  ledger.finish(taskId, {
    endedAt: Date.now(),
    summary: `failures=${result.repairCandidates.length} repair-dispatch=${repairDispatch}`,
  });
  store.setLastFired(scheduledAt);
  return { fired: true, scheduledAt, failures: result.repairCandidates.length };
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

async function dispatchDailyTaskRepair(
  deps: HandlerDeps,
  request: Parameters<DailyTaskRepairDispatch>[0],
): Promise<void> {
  if (!deps.config.loopEngineering.supervisor.enabled) {
    log.warn("daily task audit auto repair skipped because loop supervisor is disabled");
    return;
  }
  const supervisor =
    loopSupervisorSessionNames(
      deps.config.projectSessionPrefix,
      deps.config.loopEngineering.supervisor.poolSize,
    )[0] ?? "unconfigured-loop-supervisor";
  if (!(await startLoopSupervisor(deps, undefined, supervisor))) {
    log.warn("daily task audit auto repair skipped because loop supervisor could not start");
    return;
  }
  const prompt = buildDailyAuditRepairPrompt(request);
  const verdict = deps.queue.enqueue({
    id: newMessageId(),
    text: prompt,
    chatId: "daily-task-audit",
    sessionName: supervisor,
    action: "text",
    channel: "control",
    origin: "system",
    promptSource: "control",
    resolve: () => {},
    reject: (err) => log.warn("daily task audit repair prompt failed", { err }),
  });
  if (verdict !== "queued") {
    log.warn("daily task audit auto repair could not be queued", { data: { verdict } });
  }
}
