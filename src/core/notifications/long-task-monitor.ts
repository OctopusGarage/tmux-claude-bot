import { createLogger } from "../../shared/utils/logger.js";
import { readAgentRecentConversations } from "../agents/read.js";
import type { DashboardSnapshot } from "../dashboard/dashboard.js";
import { buildDashboard } from "../dashboard/dashboard.js";
import type { HandlerDeps } from "../deps.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import type { ConversationRound } from "../read/transcript.js";
import type { NotificationGateway, NotificationRequest } from "./gateway.js";
import type { OwnerActivityTracker } from "./owner-activity.js";
import { resolveNotificationTargetPlan } from "./target-resolver.js";

export const LONG_TASK_CHECK_MS = 5 * 60 * 1000;
export const LONG_TASK_THRESHOLD_MS = 3 * 60 * 1000;

type SnapshotProvider = () => Promise<Pick<DashboardSnapshot, "sessions" | "generatedAt">>;
type FinishedTaskWindow = {
  key: string;
  startedAt: number;
  finishedBefore?: number;
};
type LatestHistoryProvider = (session: string, task: FinishedTaskWindow) => Promise<string | null>;

type WatchedTask = {
  session: string;
  label: string;
  key: string;
  startedAt: number;
  lastTaskMs: number;
  armed: boolean;
};

export type LongTaskMonitorOptions = {
  snapshot: SnapshotProvider;
  notifications: NotificationGateway;
  ownerActivity: OwnerActivityTracker;
  latestHistory?: LatestHistoryProvider;
  thresholdMs?: number;
};

const log = createLogger("notifications.long-task-monitor");

export class LongTaskMonitor {
  private readonly snapshot: SnapshotProvider;
  private readonly notifications: NotificationGateway;
  private readonly ownerActivity: OwnerActivityTracker;
  private readonly latestHistory: LatestHistoryProvider;
  private readonly thresholdMs: number;
  private readonly watched = new Map<string, WatchedTask>();

  constructor(opts: LongTaskMonitorOptions) {
    this.snapshot = opts.snapshot;
    this.notifications = opts.notifications;
    this.ownerActivity = opts.ownerActivity;
    this.latestHistory = opts.latestHistory ?? (async () => null);
    this.thresholdMs = opts.thresholdMs ?? LONG_TASK_THRESHOLD_MS;
  }

  async tick(): Promise<void> {
    if (this.notifications.registeredChannels().length === 0) return;

    const snap = await this.snapshot();
    const seen = new Set<string>();
    for (const row of snap.sessions) {
      if (row.operator) continue;
      seen.add(row.session);
      const watched = this.watched.get(row.session);
      if (!row.busy) {
        if (watched) {
          this.watched.delete(row.session);
          if (watched.armed) await this.notifyFinished(watched, "completed");
        }
        continue;
      }

      if (!row.task) {
        if (watched) {
          this.watched.delete(row.session);
          if (watched.armed) await this.notifyFinished(watched, "completed");
        }
        continue;
      }

      if (watched && watched.key !== row.task.key) {
        this.watched.delete(row.session);
        if (watched.armed) await this.notifyFinished(watched, "completed", row.task.startedAt);
      }

      const taskMs = row.taskMs ?? 0;
      this.watched.set(row.session, {
        session: row.session,
        label: row.label,
        key: row.task.key,
        startedAt: row.task.startedAt,
        lastTaskMs: taskMs,
        armed: (watched?.key === row.task.key && watched.armed) || taskMs >= this.thresholdMs,
      });
    }

    for (const [session, watched] of this.watched) {
      if (seen.has(session)) continue;
      this.watched.delete(session);
      if (watched.armed) await this.notifyFinished(watched, "session disappeared");
    }
  }

  private async notifyFinished(
    task: WatchedTask,
    reason: string,
    finishedBefore?: number,
  ): Promise<void> {
    const channels = this.notifications.registeredChannels();
    if (channels.length === 0) return;

    let latestHistory: string | null = null;
    try {
      latestHistory = await this.latestHistory(task.session, {
        key: task.key,
        startedAt: task.startedAt,
        ...(finishedBefore !== undefined ? { finishedBefore } : {}),
      });
    } catch (err) {
      log.warn("failed to read latest history for long-task notification", {
        session: task.session,
        err,
      });
    }
    const request = completionRequest(task, reason, latestHistory);
    const plan = resolveNotificationTargetPlan({
      registeredChannels: channels,
      session: task.session,
      recentOwnerChannel: this.ownerActivity.recent(),
    });
    if (plan.kind === "none") return;
    if (plan.kind === "both") {
      await this.notifications.notify({ ...request, channel: "both" });
      return;
    }
    if (plan.kind === "single") {
      await this.notifications.notify({ ...request, channel: plan.channel });
      return;
    }

    const primary = await this.notifications.notify({ ...request, channel: plan.channel });
    if (primary.status === "failed" && plan.fallback) {
      await this.notifications.notify({ ...request, channel: plan.fallback });
    }
  }
}

function completionRequest(
  task: WatchedTask,
  reason: string,
  latestHistory: string | null,
): Omit<NotificationRequest, "channel"> {
  const body = [
    `session: ${task.session}`,
    `status: ${reason}`,
    `duration: ${formatDuration(task.lastTaskMs)}`,
  ];
  const history = formatHistorySnippet(latestHistory);
  if (history) body.push("", "latest history:", history);
  return {
    level: "success",
    source: "long-task-monitor",
    session: task.session,
    title: `Long task finished: ${task.label}`,
    body: body.join("\n"),
  };
}

const HISTORY_SNIPPET_LIMIT = 1800;

function formatHistorySnippet(text: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= HISTORY_SNIPPET_LIMIT) return trimmed;
  return `${trimmed.slice(0, HISTORY_SNIPPET_LIMIT)}\n\n[truncated]`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function startLongTaskMonitor(
  deps: HandlerDeps,
  opts: { checkMs?: number; thresholdMs?: number } = {},
): () => void {
  const monitor = new LongTaskMonitor({
    snapshot: () => buildDashboard(deps),
    notifications: deps.notifications,
    ownerActivity: deps.ownerActivity,
    latestHistory: async (session, task) => {
      const projectPath = getPathBySession(session) ?? session;
      return latestAssistantForTaskWindow(
        await readAgentRecentConversations(deps.configResolver, session, projectPath),
        task,
      );
    },
    ...(opts.thresholdMs !== undefined ? { thresholdMs: opts.thresholdMs } : {}),
  });
  const tick = (): void => {
    void monitor.tick().catch((err) => log.warn("long-task monitor tick failed", { err }));
  };
  const timer = setInterval(tick, opts.checkMs ?? LONG_TASK_CHECK_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

function latestAssistantForTaskWindow(
  rounds: ConversationRound[],
  task: FinishedTaskWindow,
): string | null {
  for (const round of rounds) {
    const assistant = round.assistant.trim();
    if (!assistant) continue;
    if (round.timeMs === undefined) {
      if (task.finishedBefore === undefined) return assistant;
      continue;
    }
    if (round.timeMs < task.startedAt) continue;
    if (task.finishedBefore !== undefined && round.timeMs >= task.finishedBefore) continue;
    return assistant;
  }
  return null;
}
