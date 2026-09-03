import { describe, expect, it, vi } from "vitest";
import { admitAutomationWork } from "../../src/core/automation/admission.js";
import type { AgentCapacityView } from "../../src/core/automation/capacity.js";
import type { ResourceAdmissionInput } from "../../src/core/resource-guardian/types.js";
import type { HostPowerConfig } from "../../src/shared/types.js";

const scheduled: HostPowerConfig = {
  mode: "scheduled",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};
const atSingapore = (iso: string): number => Date.parse(`${iso}+08:00`);
const input = (overrides: Partial<ResourceAdmissionInput> = {}): ResourceAdmissionInput => ({
  source: "loop-engineering",
  trigger: "background",
  weight: "heavy",
  now: atSingapore("2026-08-11T04:00:00"),
  ...overrides,
});
const capacity = (overrides: Partial<AgentCapacityView> = {}): AgentCapacityView => ({
  agent: "codex",
  authentication: "subscription",
  state: "available",
  fiveHourPct: 10,
  weeklyPct: 20,
  resetAt: null,
  observedAt: atSingapore("2026-08-11T12:00:00"),
  nextProbeAt: atSingapore("2026-08-11T12:15:00"),
  latestReason: "usage-available",
  activeAutonomousLeases: 0,
  lastAutonomousStartAt: null,
  ...overrides,
});

describe("automation admission", () => {
  it("denies quiet-hours background work before consulting Resource Guardian", () => {
    const resourceAdmission = vi.fn(() => ({
      allowed: true as const,
      reason: "open",
      incidentId: null,
    }));
    expect(admitAutomationWork(input(), { hostPower: scheduled, resourceAdmission })).toEqual({
      allowed: false,
      reason: "quiet-hours",
      incidentId: null,
      retryAt: atSingapore("2026-08-11T09:30:00"),
    });
    expect(resourceAdmission).not.toHaveBeenCalled();
  });

  it("keeps warmup background-closed", () => {
    expect(
      admitAutomationWork(input({ now: atSingapore("2026-08-11T09:20:00") }), {
        hostPower: scheduled,
        resourceAdmission: () => ({ allowed: true, reason: "open", incidentId: null }),
      }),
    ).toEqual({
      allowed: false,
      reason: "wake-warmup",
      incidentId: null,
      retryAt: atSingapore("2026-08-11T09:30:00"),
    });
  });

  it.each(["interactive", "operator", "reconcile"] as const)(
    "passes %s through to Resource Guardian during quiet hours",
    (trigger) => {
      const resourceAdmission = vi.fn(() => ({
        allowed: true as const,
        reason: "resource-decision",
        incidentId: null,
      }));
      expect(
        admitAutomationWork(input({ trigger }), { hostPower: scheduled, resourceAdmission }),
      ).toMatchObject({ allowed: true, reason: "resource-decision" });
      expect(resourceAdmission).toHaveBeenCalledOnce();
    },
  );

  it("passes service-window background work to Resource Guardian", () => {
    const resourceAdmission = vi.fn(() => ({
      allowed: false as const,
      reason: "resource pressure",
      incidentId: "incident-1",
    }));
    expect(
      admitAutomationWork(input({ now: atSingapore("2026-08-11T12:00:00") }), {
        hostPower: scheduled,
        resourceAdmission,
      }),
    ).toEqual({ allowed: false, reason: "resource pressure", incidentId: "incident-1" });
    expect(resourceAdmission).toHaveBeenCalledOnce();
  });

  it("defaults to unmanaged host power for explicit library callers", () => {
    const resourceAdmission = vi.fn(() => ({
      allowed: true as const,
      reason: "open",
      incidentId: null,
    }));
    expect(admitAutomationWork(input(), { resourceAdmission })).toMatchObject({ allowed: true });
    expect(resourceAdmission).toHaveBeenCalledOnce();
  });

  it("defers until the persisted occurrence execution time", () => {
    const resourceAdmission = vi.fn(() => ({
      allowed: true as const,
      reason: "open",
      incidentId: null,
    }));
    expect(
      admitAutomationWork(input({ now: 1_000 }), {
        occurrence: {
          schemaVersion: 1,
          id: "project-a@1000",
          key: "project-a",
          scheduledAt: 1_000,
          notBefore: 2_000,
          status: "planned",
          updatedAt: 1_000,
        },
        resourceAdmission,
      }),
    ).toEqual({
      allowed: false,
      reason: "occurrence-not-before",
      incidentId: null,
      retryAt: 2_000,
    });
    expect(resourceAdmission).not.toHaveBeenCalled();
  });

  it("requires continuous inactivity before admitting background work", () => {
    const now = atSingapore("2026-08-11T12:00:00");
    const resourceAdmission = vi.fn(() => ({
      allowed: true as const,
      reason: "open",
      incidentId: null,
    }));
    expect(
      admitAutomationWork(input({ now }), {
        ownerLastActivityAt: now - 5 * 60_000,
        resourceAdmission,
      }),
    ).toEqual({
      allowed: false,
      reason: "recent-owner-activity",
      incidentId: null,
      retryAt: now + 10 * 60_000,
    });
    expect(resourceAdmission).not.toHaveBeenCalled();
  });

  it("applies capacity policy before Resource Guardian", () => {
    const now = atSingapore("2026-08-11T12:00:00");
    const resetAt = now + 60_000;
    const resourceAdmission = vi.fn(() => ({
      allowed: true as const,
      reason: "open",
      incidentId: null,
    }));
    expect(
      admitAutomationWork(input({ now }), {
        capacity: capacity({ state: "exhausted", resetAt }),
        resourceAdmission,
      }),
    ).toEqual({
      allowed: false,
      reason: "capacity-exhausted",
      incidentId: null,
      retryAt: resetAt,
    });
    expect(resourceAdmission).not.toHaveBeenCalled();
  });

  it("serializes autonomous heavy work even when usage capacity is available", () => {
    const now = atSingapore("2026-08-11T12:00:00");
    const resourceAdmission = vi.fn(() => ({
      allowed: true as const,
      reason: "open",
      incidentId: null,
    }));

    expect(
      admitAutomationWork(input({ now }), {
        capacity: capacity({ activeAutonomousLeases: 1 }),
        resourceAdmission,
      }),
    ).toEqual({
      allowed: false,
      reason: "autonomous-heavy-active-lease",
      incidentId: null,
      retryAt: now + 15 * 60_000,
    });
    expect(resourceAdmission).not.toHaveBeenCalled();
  });

  it("does not serialize reconcile work for an existing autonomous lease", () => {
    const now = atSingapore("2026-08-11T12:00:00");
    const resourceAdmission = vi.fn(() => ({
      allowed: true as const,
      reason: "open",
      incidentId: null,
    }));

    expect(
      admitAutomationWork(input({ now, trigger: "reconcile" }), {
        capacity: capacity({ activeAutonomousLeases: 1 }),
        resourceAdmission,
      }),
    ).toEqual({ allowed: true, reason: "open", incidentId: null });
    expect(resourceAdmission).toHaveBeenCalledOnce();
  });

  it("does not apply recent-activity deferral to operator work", () => {
    const now = atSingapore("2026-08-11T12:00:00");
    expect(
      admitAutomationWork(input({ now, trigger: "operator" }), {
        ownerLastActivityAt: now,
        capacity: capacity({ state: "constrained" }),
        resourceAdmission: () => ({ allowed: true, reason: "open", incidentId: null }),
      }),
    ).toMatchObject({ allowed: true });
  });
});
