import type { NotificationRequest } from "./gateway.js";

export type LongTaskFinishedEvent = {
  kind: "long-task.finished";
  session: string;
  label: string;
  status: string;
  durationMs: number;
  latestHistory?: string | null;
};

export type NotificationEvent = LongTaskFinishedEvent;

export function notificationRequestForEvent(
  event: NotificationEvent,
): Omit<NotificationRequest, "channel"> {
  return longTaskFinishedRequest(event);
}

function longTaskFinishedRequest(
  event: LongTaskFinishedEvent,
): Omit<NotificationRequest, "channel"> {
  const body = [
    `session: ${event.session}`,
    `status: ${event.status}`,
    `duration: ${formatDuration(event.durationMs)}`,
  ];
  const history = formatHistorySnippet(event.latestHistory ?? null);
  if (history) body.push("", "latest history:", history);
  return {
    level: "success",
    source: "long-task-monitor",
    session: event.session,
    title: `Long task finished: ${event.label}`,
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

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
