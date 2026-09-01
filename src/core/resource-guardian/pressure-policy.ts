import type {
  PressureMemory,
  PressureProfile,
  ResourceGuardianProfile,
  ResourceSample,
} from "./types.js";

const seconds = (value: number): number => value * 1_000;
const CONTROL_REQUEST_WINDOW_MS = seconds(30);

export const PRESSURE_PROFILES = Object.freeze({
  balanced: Object.freeze({
    elevatedCpuPct: 80,
    elevatedSustainMs: seconds(60),
    criticalCpuPct: 92,
    criticalSustainMs: seconds(90),
    emergencyCpuPct: 97,
    emergencySustainMs: seconds(180),
    thermalSustainMs: seconds(15),
    recoveryCpuPct: 65,
    recoveringAfterMs: seconds(300),
    healthyAfterMs: seconds(600),
  }),
  conservative: Object.freeze({
    elevatedCpuPct: 75,
    elevatedSustainMs: seconds(60),
    criticalCpuPct: 88,
    criticalSustainMs: seconds(90),
    emergencyCpuPct: 95,
    emergencySustainMs: seconds(180),
    thermalSustainMs: seconds(15),
    recoveryCpuPct: 55,
    recoveringAfterMs: seconds(300),
    healthyAfterMs: seconds(600),
  }),
}) satisfies Readonly<Record<ResourceGuardianProfile, Readonly<PressureProfile>>>;

export function initialPressureMemory(now: number): PressureMemory {
  return {
    pressure: "healthy",
    stateSince: now,
    elevatedSince: null,
    criticalSince: null,
    emergencySince: null,
    thermalSince: null,
    recoverySince: null,
  };
}

function sustainedSince(
  capturedAt: number,
  isAboveThreshold: boolean,
  previousSince: number | null,
): number | null {
  if (!isAboveThreshold) return null;
  return previousSince ?? capturedAt;
}

function hasSustainedPressure(
  capturedAt: number,
  since: number | null,
  sustainMs: number,
): boolean {
  return since !== null && capturedAt - since >= sustainMs;
}

function withPressure(
  memory: PressureMemory,
  pressure: PressureMemory["pressure"],
  capturedAt: number,
): PressureMemory {
  return {
    ...memory,
    pressure,
    stateSince: memory.pressure === pressure ? memory.stateSince : capturedAt,
  };
}

function resetHealthy(capturedAt: number): PressureMemory {
  return initialPressureMemory(capturedAt);
}

function pressurePctFor(sample: ResourceSample): number {
  return Math.max(sample.hostCpuPct, sample.loadPct);
}

function hasSevereEventLoopLag(sample: ResourceSample): boolean {
  return sample.eventLoopLagMs > CONTROL_REQUEST_WINDOW_MS;
}

export function advancePressureState(
  previous: PressureMemory,
  sample: ResourceSample,
  profileName: ResourceGuardianProfile,
): PressureMemory {
  const profile = PRESSURE_PROFILES[profileName];
  const { capturedAt } = sample;
  const pressurePct = pressurePctFor(sample);
  const next: PressureMemory = {
    ...previous,
    elevatedSince: sustainedSince(
      capturedAt,
      pressurePct >= profile.elevatedCpuPct,
      previous.elevatedSince,
    ),
    criticalSince: sustainedSince(
      capturedAt,
      pressurePct >= profile.criticalCpuPct,
      previous.criticalSince,
    ),
    emergencySince: sustainedSince(
      capturedAt,
      pressurePct >= profile.emergencyCpuPct,
      previous.emergencySince,
    ),
    thermalSince: sustainedSince(
      sample.capturedAt,
      sample.thermal === "pressure",
      previous.thermalSince,
    ),
  };

  const emergency =
    hasSustainedPressure(capturedAt, next.emergencySince, profile.emergencySustainMs) ||
    hasSustainedPressure(capturedAt, next.thermalSince, profile.thermalSustainMs);
  const severeEventLoopLag = hasSevereEventLoopLag(sample);
  const critical =
    severeEventLoopLag ||
    hasSustainedPressure(capturedAt, next.criticalSince, profile.criticalSustainMs);
  const elevated = hasSustainedPressure(capturedAt, next.elevatedSince, profile.elevatedSustainMs);

  if (previous.pressure === "healthy") {
    if (emergency) return { ...withPressure(next, "emergency", capturedAt), recoverySince: null };
    if (critical) return withPressure(next, "critical", capturedAt);
    if (elevated) return withPressure(next, "elevated", capturedAt);
    return withPressure(next, "healthy", capturedAt);
  }

  if (previous.pressure === "elevated") {
    if (emergency) return { ...withPressure(next, "emergency", capturedAt), recoverySince: null };
    if (critical) return withPressure(next, "critical", capturedAt);
    if (pressurePct < profile.elevatedCpuPct) return resetHealthy(capturedAt);
    return withPressure(next, "elevated", capturedAt);
  }

  if (previous.pressure === "critical" || previous.pressure === "emergency") {
    if (emergency) return { ...withPressure(next, "emergency", capturedAt), recoverySince: null };

    // Thermal pressure is itself an active emergency signal; wait for it to
    // clear before allowing CPU recovery to make progress.
    if (
      sample.thermal === "pressure" ||
      severeEventLoopLag ||
      pressurePct >= profile.recoveryCpuPct
    ) {
      return { ...withPressure(next, previous.pressure, capturedAt), recoverySince: null };
    }

    const recoverySince = previous.recoverySince ?? capturedAt;
    const recoveringFor = capturedAt - recoverySince;
    const recovering = { ...next, recoverySince };
    if (recoveringFor >= profile.healthyAfterMs) return resetHealthy(capturedAt);
    if (recoveringFor >= profile.recoveringAfterMs) {
      return withPressure(recovering, "recovering", capturedAt);
    }
    return withPressure(recovering, previous.pressure, capturedAt);
  }

  // A recovery interruption must return to a guarded state. A fresh low-CPU
  // interval starts the recovery clock again from its first sample.
  if (emergency) return { ...withPressure(next, "emergency", capturedAt), recoverySince: null };
  if (
    severeEventLoopLag ||
    pressurePct >= profile.recoveryCpuPct ||
    sample.thermal === "pressure"
  ) {
    return { ...withPressure(next, "critical", capturedAt), recoverySince: null };
  }

  const recoverySince = previous.recoverySince ?? capturedAt;
  const recoveringFor = capturedAt - recoverySince;
  const recovering = { ...next, recoverySince };
  if (recoveringFor >= profile.healthyAfterMs) return resetHealthy(capturedAt);
  return withPressure(recovering, "recovering", capturedAt);
}
