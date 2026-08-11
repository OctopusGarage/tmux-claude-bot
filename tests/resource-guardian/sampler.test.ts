import { describe, expect, it, vi } from "vitest";
import { cpuTotalsFromEntries } from "../../src/core/infra/system-metrics.js";
import { createResourceSampler, hostCpuBusyPct } from "../../src/core/resource-guardian/sampler.js";
import type {
  DeepResourceProbe,
  LightweightProbe,
} from "../../src/core/resource-guardian/types.js";

describe("hostCpuBusyPct", () => {
  it("computes busy CPU from aggregate idle and total deltas", () => {
    expect(hostCpuBusyPct({ idle: 100, total: 400 }, { idle: 120, total: 500 })).toBe(80);
  });

  it("returns zero for non-positive totals and clamps invalid readings", () => {
    expect(hostCpuBusyPct({ idle: 100, total: 400 }, { idle: 120, total: 400 })).toBe(0);
    expect(hostCpuBusyPct({ idle: 200, total: 0 }, { idle: -100, total: 100 })).toBe(100);
    expect(hostCpuBusyPct({ idle: 0, total: 0 }, { idle: 200, total: 100 })).toBe(0);
  });

  it("returns zero when CPU deltas are not finite", () => {
    expect(hostCpuBusyPct({ idle: 0, total: Number.NaN }, { idle: 10, total: 100 })).toBe(0);
    expect(
      hostCpuBusyPct({ idle: 0, total: 0 }, { idle: Number.POSITIVE_INFINITY, total: 100 }),
    ).toBe(0);
    expect(
      hostCpuBusyPct({ idle: 0, total: 0 }, { idle: 10, total: Number.POSITIVE_INFINITY }),
    ).toBe(0);
  });
});

describe("cpuTotalsFromEntries", () => {
  it("aggregates heterogeneous CPU time entries", () => {
    expect(
      cpuTotalsFromEntries([
        { times: { user: 11, nice: 2, sys: 3, idle: 4, irq: 5 } },
        { times: { user: 101, nice: 20, sys: 30, idle: 40, irq: 50 } },
      ]),
    ).toEqual({ idle: 44, total: 266 });
  });
});

describe("createResourceSampler", () => {
  const lightweightProbe = (): LightweightProbe => {
    const totals = [
      { idle: 100, total: 400 },
      { idle: 120, total: 500 },
    ];
    return {
      cpuTotals: () => totals.shift() ?? { idle: 120, total: 500 },
      loadAverage: () => [2, 1, 0.5],
      cpuCount: () => 4,
    };
  };

  it("uses the first sample only as its CPU baseline", async () => {
    const sampler = createResourceSampler(lightweightProbe(), async () => {
      throw new Error("deep probe must not run");
    });

    await expect(
      sampler.sample({ now: 100, scheduledAt: 110, deep: false }),
    ).resolves.toMatchObject({
      capturedAt: 100,
      hostCpuPct: 0,
      loadPct: 50,
      eventLoopLagMs: 0,
      thermal: "unknown",
    });
  });

  it("uses CPU totals rather than load average after a baseline is established", async () => {
    const sampler = createResourceSampler(lightweightProbe(), async () => {
      throw new Error("deep probe must not run");
    });

    await sampler.sample({ now: 100, scheduledAt: 90, deep: false });
    await expect(
      sampler.sample({ now: 140, scheduledAt: 125, deep: false }),
    ).resolves.toMatchObject({
      hostCpuPct: 80,
      loadPct: 50,
      eventLoopLagMs: 15,
    });
  });

  it("resets CPU and lag baselines after a host-suspension gap", async () => {
    const sampler = createResourceSampler(lightweightProbe(), async () => {
      throw new Error("deep probe must not run");
    });

    await sampler.sample({ now: 100, scheduledAt: 90, deep: false });
    await expect(
      sampler.sample({ now: 3_600_140, scheduledAt: 125, deep: false }),
    ).resolves.toMatchObject({ hostCpuPct: 0, eventLoopLagMs: 0 });
  });

  it("copies the CPU baseline when a probe reuses its totals object", async () => {
    const totals = { idle: 100, total: 400 };
    const sampler = createResourceSampler(
      {
        cpuTotals: () => totals,
        loadAverage: () => [2, 1, 0.5],
        cpuCount: () => 4,
      },
      async () => {
        throw new Error("deep probe must not run");
      },
    );

    await sampler.sample({ now: 100, scheduledAt: 90, deep: false });
    totals.idle = 120;
    totals.total = 500;

    await expect(
      sampler.sample({ now: 140, scheduledAt: 125, deep: false }),
    ).resolves.toMatchObject({
      hostCpuPct: 80,
    });
  });

  it("does not call the deep probe for a lightweight sample", async () => {
    const deepProbe = vi.fn<DeepResourceProbe>();
    const sampler = createResourceSampler(lightweightProbe(), deepProbe);

    await sampler.sample({ now: 100, scheduledAt: 90, deep: false });

    expect(deepProbe).not.toHaveBeenCalled();
  });

  it.each([0, -1])("uses zero load percentage when cpuCount is %i", async (cpuCount) => {
    const sampler = createResourceSampler(
      {
        cpuTotals: () => ({ idle: 100, total: 400 }),
        loadAverage: () => [2, 1, 0.5],
        cpuCount: () => cpuCount,
      },
      async () => {
        throw new Error("deep probe must not run");
      },
    );

    const sample = await sampler.sample({ now: 100, scheduledAt: 90, deep: false });

    expect(sample).toMatchObject({ hostCpuPct: 0, eventLoopLagMs: 10, loadPct: 0 });
    expect(Number.isFinite(sample.loadPct)).toBe(true);
  });

  it("includes one deep snapshot when explicitly requested", async () => {
    const deepSnapshot = {
      capturedAt: 101,
      thermal: "pressure" as const,
      processes: [
        {
          pid: 42,
          ppid: 1,
          pgid: 42,
          startedAt: "2026-08-09T00:00:00.000Z",
          cpuPct: 12.5,
          rssKb: 1024,
          command: "node",
        },
      ],
    };
    const deepProbe = vi.fn<DeepResourceProbe>().mockResolvedValue(deepSnapshot);
    const sampler = createResourceSampler(lightweightProbe(), deepProbe);

    const sample = await sampler.sample({ now: 100, scheduledAt: 90, deep: true });

    expect(deepProbe).toHaveBeenCalledTimes(1);
    expect(sample.thermal).toBe("pressure");
    expect(sample.deepSnapshot).toEqual(deepSnapshot);
  });
});
