import type {
  PressureState,
  ResourceCircuitAdmission,
  ResourceSamplingNotificationPhase,
} from "../resource-guardian/types.js";
import type { NotificationRequest } from "./gateway.js";

export type LongTaskFinishedEvent = {
  kind: "long-task.finished";
  session: string;
  label: string;
  status: string;
  durationMs: number;
  latestHistory?: string | null;
};

export type ResourcePressureTransitionEvent = {
  kind: "resource.pressure-transition";
  oldState: PressureState;
  newState: PressureState;
  incidentId: string | null;
  hostCpuPct: number;
  circuit: ResourceCircuitAdmission;
  actionSummary: string;
};

export type ResourceSamplingDegradedEvent = {
  kind: "resource.sampling-degraded";
  phase: ResourceSamplingNotificationPhase;
  incidentId: string | null;
  error: string;
  consecutiveFailures: number;
  circuit: ResourceCircuitAdmission;
};

export type ResourceActionFailedEvent = {
  kind: "resource.action-failed";
  incidentId: string | null;
  circuit: ResourceCircuitAdmission;
  reason: string;
};

export type NotificationEvent =
  | LongTaskFinishedEvent
  | ResourcePressureTransitionEvent
  | ResourceSamplingDegradedEvent
  | ResourceActionFailedEvent;

export function notificationRequestForEvent(
  event: NotificationEvent,
): Omit<NotificationRequest, "channel"> {
  if (event.kind === "resource.pressure-transition") {
    return resourcePressureTransitionRequest(event);
  }
  if (event.kind === "resource.sampling-degraded") {
    return resourceSamplingDegradedRequest(event);
  }
  if (event.kind === "resource.action-failed") return resourceActionFailedRequest(event);
  return longTaskFinishedRequest(event);
}

function resourceActionFailedRequest(
  event: ResourceActionFailedEvent,
): Omit<NotificationRequest, "channel"> {
  return {
    level: "error",
    source: "resource-guardian",
    title: "Resource action failed",
    body: [
      `incident: ${event.incidentId ?? "none"}`,
      `circuit: ${event.circuit}`,
      `reason: ${event.reason}`,
    ].join("\n"),
  };
}

function resourceSamplingDegradedRequest(
  event: ResourceSamplingDegradedEvent,
): Omit<NotificationRequest, "channel"> {
  return {
    level: "warning",
    source: "resource-guardian",
    title:
      event.phase === "stale-hold-expired"
        ? "Resource sampling stale hold expired"
        : "Resource sampling degraded",
    body: [
      `phase: ${event.phase}`,
      `incident: ${event.incidentId ?? "none"}`,
      `failures: ${event.consecutiveFailures}`,
      `circuit: ${event.circuit}`,
      `error: ${event.error}`,
    ].join("\n"),
  };
}

function resourcePressureTransitionRequest(
  event: ResourcePressureTransitionEvent,
): Omit<NotificationRequest, "channel"> {
  const level =
    event.newState === "healthy" ? "success" : event.newState === "emergency" ? "error" : "warning";
  return {
    level,
    source: "resource-guardian",
    title: `Resource pressure: ${event.oldState} → ${event.newState}`,
    body: [
      `incident: ${event.incidentId ?? "none"}`,
      `host CPU: ${event.hostCpuPct}%`,
      `circuit: ${event.circuit}`,
      `action: ${event.actionSummary}`,
    ].join("\n"),
  };
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
