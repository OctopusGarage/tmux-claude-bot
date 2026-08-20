import { describe, expect, it } from "vitest";
import {
  decideCapacityAdmission,
  deriveAgentCapacity,
} from "../../../src/core/automation/capacity.js";

const now = Date.parse("2026-08-13T10:00:00Z");

describe("deriveAgentCapacity", () => {
  it("treats missing and stale usage evidence as unknown rather than zero", () => {
    expect(
      deriveAgentCapacity({ agent: "codex", authentication: "subscription", now }),
    ).toMatchObject({ state: "unknown", latestReason: "usage-telemetry-unavailable" });
    expect(
      deriveAgentCapacity({
        agent: "codex",
        authentication: "subscription",
        now,
        usage: {
          sessionId: "safe-category-only",
          contextPct: null,
          fiveHourPct: 10,
          fiveHourReset: null,
          sevenDayPct: 10,
          sevenDayReset: null,
          updatedAt: (now - 16 * 60_000) / 1_000,
        },
      }),
    ).toMatchObject({ state: "unknown", latestReason: "usage-telemetry-stale" });
  });

  it.each([
    [20, "available"],
    [90, "constrained"],
    [99, "exhausted"],
  ] as const)("maps %s percent to %s", (fiveHourPct, state) => {
    expect(
      deriveAgentCapacity({
        agent: "codex",
        authentication: "subscription",
        now,
        usage: {
          sessionId: "safe-category-only",
          contextPct: null,
          fiveHourPct,
          fiveHourReset: now / 1_000 + 600,
          sevenDayPct: 5,
          sevenDayReset: null,
          updatedAt: now / 1_000,
        },
      }),
    ).toMatchObject({ state, resetAt: state === "exhausted" ? now + 600_000 : null });
  });

  it("does not keep exhausted state from a usage window whose reset already passed", () => {
    expect(
      deriveAgentCapacity({
        agent: "codex",
        authentication: "subscription",
        now,
        usage: {
          sessionId: "safe-category-only",
          contextPct: null,
          fiveHourPct: 99,
          fiveHourReset: now / 1_000 - 60,
          sevenDayPct: 5,
          sevenDayReset: null,
          updatedAt: now / 1_000,
        },
      }),
    ).toMatchObject({
      state: "unknown",
      latestReason: "usage-telemetry-reset-passed",
      nextProbeAt: now + 15 * 60_000,
    });
  });
});

describe("decideCapacityAdmission", () => {
  it("waits for the official reset when capacity is exhausted", () => {
    expect(
      decideCapacityAdmission({
        now,
        state: "exhausted",
        resetAt: now + 600_000,
        trigger: "background",
        activeLeases: 0,
        lastAutonomousStartAt: null,
        repairDepth: 0,
      }),
    ).toEqual({ allowed: false, reason: "capacity-exhausted", retryAt: now + 600_000 });
  });

  it("uses conservative concurrency and cooldown when telemetry is unknown", () => {
    const base = {
      now,
      state: "unknown" as const,
      resetAt: null,
      trigger: "background" as const,
      repairDepth: 0,
    };
    expect(
      decideCapacityAdmission({ ...base, activeLeases: 1, lastAutonomousStartAt: null }),
    ).toMatchObject({ allowed: false, reason: "capacity-unknown-active-lease" });
    expect(
      decideCapacityAdmission({
        ...base,
        activeLeases: 0,
        lastAutonomousStartAt: now - 5 * 60_000,
      }),
    ).toEqual({
      allowed: false,
      reason: "capacity-unknown-cooldown",
      retryAt: now + 25 * 60_000,
    });
    expect(
      decideCapacityAdmission({ ...base, activeLeases: 0, lastAutonomousStartAt: null }),
    ).toEqual({ allowed: true, reason: "capacity-unknown-conservative" });
  });

  it("refuses repair chaining while telemetry is unknown", () => {
    expect(
      decideCapacityAdmission({
        now,
        state: "unknown",
        resetAt: null,
        trigger: "resource-repair",
        activeLeases: 0,
        lastAutonomousStartAt: null,
        repairDepth: 1,
      }),
    ).toMatchObject({ allowed: false, reason: "capacity-unknown-repair-chain" });
  });

  it("defers background work when constrained but preserves operator admission", () => {
    const base = {
      now,
      state: "constrained" as const,
      resetAt: null,
      activeLeases: 0,
      lastAutonomousStartAt: null,
      repairDepth: 0,
    };
    expect(decideCapacityAdmission({ ...base, trigger: "background" })).toMatchObject({
      allowed: false,
      reason: "capacity-constrained",
    });
    expect(decideCapacityAdmission({ ...base, trigger: "operator" })).toEqual({
      allowed: true,
      reason: "operator-work",
    });
  });
});
