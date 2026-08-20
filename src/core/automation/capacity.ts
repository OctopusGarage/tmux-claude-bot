import type { AgentKind } from "../agents/types.js";
import type { UsageSnapshot } from "../read/usage.js";

export type AgentAuthenticationCategory = "subscription" | "usage-based" | "unknown";
export type AgentCapacityState = "available" | "constrained" | "exhausted" | "unknown";

export type AgentCapacityObservation = {
  agent: AgentKind;
  authentication: AgentAuthenticationCategory;
  state: AgentCapacityState;
  fiveHourPct: number | null;
  weeklyPct: number | null;
  resetAt: number | null;
  observedAt: number;
  nextProbeAt: number;
  latestReason: string;
};

export type AgentCapacityView = AgentCapacityObservation & {
  activeAutonomousLeases: number;
  lastAutonomousStartAt: number | null;
};

const TELEMETRY_FRESH_MS = 15 * 60_000;
const REPROBE_MS = 15 * 60_000;
const UNKNOWN_START_INTERVAL_MS = 30 * 60_000;

function finitePercent(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function deriveAgentCapacity(input: {
  agent: AgentKind;
  authentication: AgentAuthenticationCategory;
  now: number;
  usage?: UsageSnapshot | null;
  constrainedPct?: number;
  exhaustedPct?: number;
}): AgentCapacityObservation {
  const usage = input.usage ?? null;
  const unknown = (reason: string): AgentCapacityObservation => ({
    agent: input.agent,
    authentication: input.authentication,
    state: "unknown",
    fiveHourPct: null,
    weeklyPct: null,
    resetAt: null,
    observedAt: input.now,
    nextProbeAt: input.now + REPROBE_MS,
    latestReason: reason,
  });
  if (usage === null) return unknown("usage-telemetry-unavailable");
  if (
    !Number.isFinite(usage.updatedAt) ||
    input.now - usage.updatedAt * 1_000 > TELEMETRY_FRESH_MS
  ) {
    return unknown("usage-telemetry-stale");
  }

  const fiveHourPct = finitePercent(usage.fiveHourPct);
  const weeklyPct = finitePercent(usage.sevenDayPct);
  if (fiveHourPct === null && weeklyPct === null) return unknown("usage-telemetry-incomplete");
  const constrainedPct = input.constrainedPct ?? 90;
  const exhaustedPct = input.exhaustedPct ?? 99;
  const exhaustedWindows = [
    { pct: fiveHourPct, reset: usage.fiveHourReset },
    { pct: weeklyPct, reset: usage.sevenDayReset },
  ].filter((window) => window.pct !== null && window.pct >= exhaustedPct);
  const activeExhaustedWindows = exhaustedWindows.filter(
    (window) => typeof window.reset !== "number" || window.reset * 1_000 > input.now,
  );
  if (exhaustedWindows.length > 0 && activeExhaustedWindows.length === 0) {
    return unknown("usage-telemetry-reset-passed");
  }
  const state: AgentCapacityState =
    activeExhaustedWindows.length > 0
      ? "exhausted"
      : [fiveHourPct, weeklyPct].some((percent) => percent !== null && percent >= constrainedPct)
        ? "constrained"
        : "available";
  const resetCandidates = activeExhaustedWindows
    .map((window) => window.reset)
    .filter((reset): reset is number => typeof reset === "number" && reset * 1_000 > input.now)
    .map((reset) => reset * 1_000);
  const resetAt =
    state === "exhausted" && resetCandidates.length === activeExhaustedWindows.length
      ? Math.max(...resetCandidates)
      : null;
  return {
    agent: input.agent,
    authentication: input.authentication,
    state,
    fiveHourPct,
    weeklyPct,
    resetAt,
    observedAt: input.now,
    nextProbeAt: resetAt ?? input.now + REPROBE_MS,
    latestReason: `usage-${state}`,
  };
}

export type CapacityAdmissionDecision =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string; retryAt?: number };

export function decideCapacityAdmission(input: {
  now: number;
  state: AgentCapacityState;
  resetAt: number | null;
  trigger: "interactive" | "operator" | "background" | "reconcile" | "resource-repair";
  activeLeases: number;
  lastAutonomousStartAt: number | null;
  repairDepth: number;
}): CapacityAdmissionDecision {
  if (input.state === "exhausted") {
    return {
      allowed: false,
      reason: "capacity-exhausted",
      ...(input.resetAt === null ? {} : { retryAt: input.resetAt }),
    };
  }
  if (input.trigger === "interactive" || input.trigger === "operator") {
    return { allowed: true, reason: "operator-work" };
  }
  if (input.state === "constrained") return { allowed: false, reason: "capacity-constrained" };
  if (input.state === "available") return { allowed: true, reason: "capacity-available" };
  if (input.repairDepth > 0) {
    return {
      allowed: false,
      reason: "capacity-unknown-repair-chain",
      retryAt: input.now + REPROBE_MS,
    };
  }
  if (input.activeLeases > 0) {
    return {
      allowed: false,
      reason: "capacity-unknown-active-lease",
      retryAt: input.now + REPROBE_MS,
    };
  }
  if (
    input.lastAutonomousStartAt !== null &&
    input.now - input.lastAutonomousStartAt < UNKNOWN_START_INTERVAL_MS
  ) {
    return {
      allowed: false,
      reason: "capacity-unknown-cooldown",
      retryAt: input.lastAutonomousStartAt + UNKNOWN_START_INTERVAL_MS,
    };
  }
  return { allowed: true, reason: "capacity-unknown-conservative" };
}
