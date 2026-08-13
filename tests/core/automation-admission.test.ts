import { describe, expect, it, vi } from "vitest";
import { admitAutomationWork } from "../../src/core/automation/admission.js";
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
    });
    expect(resourceAdmission).not.toHaveBeenCalled();
  });

  it("keeps warmup background-closed", () => {
    expect(
      admitAutomationWork(input({ now: atSingapore("2026-08-11T09:20:00") }), {
        hostPower: scheduled,
        resourceAdmission: () => ({ allowed: true, reason: "open", incidentId: null }),
      }),
    ).toEqual({ allowed: false, reason: "wake-warmup", incidentId: null });
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
});
