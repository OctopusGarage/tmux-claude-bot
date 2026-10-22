import type { AgentCapacityState } from "./capacity.js";
import type { AgentCapacityTransition } from "./coordinator.js";

type CapacityRefreshView = {
  observedAt: number;
  nextProbeAt: number;
  state: AgentCapacityState;
  latestReason: string;
  activeAutonomousLeases: number;
  now: number;
};

export function shouldRefreshCapacityNow(view: CapacityRefreshView): boolean {
  if (view.observedAt <= 0) return true;
  if (view.nextProbeAt <= view.now) return true;
  return view.state === "unknown" && view.latestReason.startsWith("usage-telemetry-");
}

function capacityTransitionExplanation(transition: AgentCapacityTransition): string[] {
  if (transition.reason === "usage-telemetry-stale") {
    return [
      "Local Codex usage telemetry is stale, so automation cannot prove current capacity.",
      "This does not mean the quota is exhausted.",
      "Until fresh telemetry is observed, background automation will wait or run conservatively.",
    ];
  }
  if (transition.reason === "usage-telemetry-unavailable") {
    return [
      "Local usage telemetry is unavailable, so automation cannot prove current capacity.",
      "This does not mean the quota is exhausted.",
      "Background automation will wait or run conservatively until telemetry is available.",
    ];
  }
  if (transition.reason === "usage-telemetry-incomplete") {
    return [
      "Local usage telemetry did not include quota percentages.",
      "Background automation will wait or run conservatively until a complete snapshot is available.",
    ];
  }
  if (transition.reason === "official-limit-signal") {
    return ["The running agent reported an official usage limit signal."];
  }
  if (transition.reason === "usage-available") {
    return ["Fresh local usage telemetry shows capacity is available again."];
  }
  return [`Reason: ${transition.reason}`];
}

export function formatCapacityTransitionNotification(transition: AgentCapacityTransition): {
  title: string;
  body: string;
} {
  const title =
    transition.to === "exhausted"
      ? `${transition.agent} capacity exhausted`
      : transition.to === "available"
        ? `${transition.agent} capacity recovered`
        : `${transition.agent} capacity ${transition.to}`;
  const body = [
    `Capacity changed from ${transition.from} to ${transition.to}.`,
    ...capacityTransitionExplanation(transition),
    ...(transition.resetAt === null
      ? []
      : [`Next probe: ${new Date(transition.resetAt).toISOString()}`]),
  ].join("\n");
  return { title, body };
}
