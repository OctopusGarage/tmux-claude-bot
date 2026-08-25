import { cpus, loadavg } from "node:os";

import { hostCpuBusyPct, hostCpuTotals } from "../infra/system-metrics.js";
import type { CpuTotals, DeepResourceProbe, LightweightProbe, ResourceSample } from "./types.js";

export { hostCpuBusyPct } from "../infra/system-metrics.js";

export type ResourceSampleRequest = {
  now: number;
  scheduledAt: number;
  deep: boolean;
};

export type ResourceSampler = {
  sample(request: ResourceSampleRequest): Promise<ResourceSample>;
};

export const RESOURCE_SUSPENSION_MIN_GAP_MS = 60_000;

export function resourceSuspensionGapMs(tickMs: number): number {
  return Math.max(RESOURCE_SUSPENSION_MIN_GAP_MS, tickMs * 4);
}

export function defaultLightweightProbe(): LightweightProbe {
  return {
    cpuTotals: hostCpuTotals,
    loadAverage: () => loadavg() as [number, number, number],
    cpuCount: () => cpus().length,
  };
}

export function createResourceSampler(
  lightweightProbe: LightweightProbe,
  deepProbe: DeepResourceProbe,
  options: { suspensionGapMs?: number } = {},
): ResourceSampler {
  let previousCpuTotals: CpuTotals | undefined;
  const suspensionGapMs = options.suspensionGapMs ?? RESOURCE_SUSPENSION_MIN_GAP_MS;

  return {
    async sample({ now, scheduledAt, deep }): Promise<ResourceSample> {
      const currentCpuTotals = lightweightProbe.cpuTotals();
      const [oneMinuteLoad] = lightweightProbe.loadAverage();
      const cpuCount = lightweightProbe.cpuCount();
      const eventLoopLagMs = Math.max(0, now - scheduledAt);
      const resumedAfterSuspension = eventLoopLagMs > suspensionGapMs;
      const baseline = previousCpuTotals;
      const hasHostCpuBaseline = baseline !== undefined && !resumedAfterSuspension;
      const hostCpuPct = hasHostCpuBaseline ? hostCpuBusyPct(baseline, currentCpuTotals) : 0;
      previousCpuTotals = { ...currentCpuTotals };
      const deepSnapshot = deep ? await deepProbe() : undefined;

      return {
        capturedAt: now,
        hostCpuPct,
        hostCpuStatus: hasHostCpuBaseline ? "available" : "unavailable",
        loadPct: cpuCount > 0 ? Math.round((oneMinuteLoad / cpuCount) * 100) : 0,
        eventLoopLagMs: resumedAfterSuspension ? 0 : eventLoopLagMs,
        thermal: deepSnapshot?.thermal ?? "unknown",
        ...(deepSnapshot ? { deepSnapshot } : {}),
      };
    },
  };
}
