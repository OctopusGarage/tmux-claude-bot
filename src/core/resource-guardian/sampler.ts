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
): ResourceSampler {
  let previousCpuTotals: CpuTotals | undefined;

  return {
    async sample({ now, scheduledAt, deep }): Promise<ResourceSample> {
      const currentCpuTotals = lightweightProbe.cpuTotals();
      const [oneMinuteLoad] = lightweightProbe.loadAverage();
      const cpuCount = lightweightProbe.cpuCount();
      const hostCpuPct = previousCpuTotals
        ? hostCpuBusyPct(previousCpuTotals, currentCpuTotals)
        : 0;
      previousCpuTotals = { ...currentCpuTotals };
      const deepSnapshot = deep ? await deepProbe() : undefined;

      return {
        capturedAt: now,
        hostCpuPct,
        loadPct: cpuCount > 0 ? Math.round((oneMinuteLoad / cpuCount) * 100) : 0,
        eventLoopLagMs: Math.max(0, now - scheduledAt),
        thermal: deepSnapshot?.thermal ?? "unknown",
        ...(deepSnapshot ? { deepSnapshot } : {}),
      };
    },
  };
}
