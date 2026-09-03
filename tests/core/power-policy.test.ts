import { describe, expect, it } from "vitest";
import {
  admitQuietHoursWork,
  resolveHostPowerPhase,
  wakeTimeFor,
} from "../../src/core/platform/power-policy.js";
import type { HostPowerConfig } from "../../src/shared/types.js";

const scheduled: HostPowerConfig = {
  mode: "scheduled",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};

const atSingapore = (iso: string): number => Date.parse(`${iso}+08:00`);

describe("host power policy", () => {
  it.each([
    ["2026-08-11T01:59:59", "service"],
    ["2026-08-11T02:00:00", "natural-sleep"],
    ["2026-08-11T09:14:59", "natural-sleep"],
    ["2026-08-11T09:15:00", "wake-warmup"],
    ["2026-08-11T09:29:59", "wake-warmup"],
    ["2026-08-11T09:30:00", "service"],
  ] as const)("classifies %s as %s", (iso, phase) => {
    expect(resolveHostPowerPhase(scheduled, atSingapore(iso))).toBe(phase);
  });

  it("derives one fixed wake fifteen minutes before quiet end", () => {
    expect(wakeTimeFor(scheduled)).toBe("09:15");
    expect(wakeTimeFor({ ...scheduled, quietEnd: "00:10" })).toBe("23:55");
  });

  it("keeps off unmanaged and always in service", () => {
    expect(
      resolveHostPowerPhase({ ...scheduled, mode: "off" }, atSingapore("2026-08-11T04:00:00")),
    ).toBe("unmanaged");
    expect(
      resolveHostPowerPhase({ ...scheduled, mode: "always" }, atSingapore("2026-08-11T04:00:00")),
    ).toBe("service");
  });

  it("defers background work during natural sleep and warmup", () => {
    expect(
      admitQuietHoursWork(scheduled, {
        trigger: "background",
        now: atSingapore("2026-08-11T04:00:00"),
      }),
    ).toEqual({
      allowed: false,
      reason: "quiet-hours",
      retryAt: atSingapore("2026-08-11T09:30:00"),
    });
    expect(
      admitQuietHoursWork(scheduled, {
        trigger: "resource-repair",
        now: atSingapore("2026-08-11T09:20:00"),
      }),
    ).toEqual({
      allowed: false,
      reason: "wake-warmup",
      retryAt: atSingapore("2026-08-11T09:30:00"),
    });
  });

  it.each(["interactive", "operator", "reconcile"] as const)(
    "allows %s work whenever the host is awake",
    (trigger) => {
      expect(
        admitQuietHoursWork(scheduled, {
          trigger,
          now: atSingapore("2026-08-11T04:00:00"),
        }),
      ).toEqual({ allowed: true, reason: trigger });
    },
  );

  it("uses the configured IANA timezone instead of the process timezone", () => {
    expect(
      resolveHostPowerPhase(
        { ...scheduled, timezone: "America/Los_Angeles" },
        Date.parse("2026-08-11T10:30:00Z"),
      ),
    ).toBe("natural-sleep");
  });
});
