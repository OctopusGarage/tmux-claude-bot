import { readlinkSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createPowerScheduleProbe,
  inspectPowerSchedule,
  type PowerScheduleProbe,
} from "../../src/core/platform/power-schedule.js";
import type { HostPowerConfig } from "../../src/shared/types.js";

const config: HostPowerConfig = {
  mode: "scheduled",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};

function probe(output: string, overrides: Partial<PowerScheduleProbe> = {}): PowerScheduleProbe {
  return {
    platform: "darwin",
    readSchedule: vi.fn(() => output),
    localTimezone: vi.fn(() => "Asia/Singapore"),
    now: () => Date.parse("2026-08-11T00:00:00Z"),
    runPrivileged: vi.fn(),
    ...overrides,
  };
}

describe("macOS power schedule inspection", () => {
  it.runIf(process.platform === "darwin")(
    "reads the macOS system timezone independently of the process TZ environment",
    () => {
      const marker = "/zoneinfo/";
      const localtimeTarget = readlinkSync("/etc/localtime");
      const systemTimezone = localtimeTarget.slice(localtimeTarget.indexOf(marker) + marker.length);
      const originalTimezone = process.env.TZ;
      process.env.TZ = systemTimezone === "Asia/Tokyo" ? "Asia/Singapore" : "Asia/Tokyo";

      try {
        expect(createPowerScheduleProbe().localTimezone()).toBe(systemTimezone);
      } finally {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
      }
    },
  );

  it("verifies the exact daily wake schedule", () => {
    expect(
      inspectPowerSchedule(
        config,
        probe("Repeating power events:\n  wake at 9:15AM every day\nScheduled power events:\n"),
      ),
    ).toMatchObject({ status: "verified", wakeAt: "09:15" });
  });

  it("treats Apple invisible one-off events as unrelated", () => {
    expect(
      inspectPowerSchedule(
        config,
        probe(
          "Scheduled power events:\n [0] wake at 08/12/2026 07:52:09 by 'com.apple.alarm.user-invisible.example'\n",
        ),
      ),
    ).toMatchObject({ status: "missing", wakeAt: "09:15" });
  });

  it.each([
    "Repeating power events:\n  wake at 8:00AM every day\n",
    "Repeating power events:\n  wakeorpoweron at 9:15AM every day\n",
    "Repeating power events:\n  wake at 9:15AM every weekday\n",
    "Repeating power events:\n  wake at 9:15AM every day\n  sleep at 1:00AM every day\n",
  ])("refuses a conflicting repeating schedule", (output) => {
    expect(inspectPowerSchedule(config, probe(output))).toMatchObject({ status: "conflict" });
  });

  it("translates the configured wake into the host local clock", () => {
    expect(
      inspectPowerSchedule(
        config,
        probe("Repeating power events:\n  wake at 10:15AM every day\n", {
          localTimezone: () => "Asia/Tokyo",
        }),
      ),
    ).toMatchObject({
      status: "verified",
      wakeAt: "09:15",
      timezone: "Asia/Singapore",
      hostWakeAt: "10:15",
      hostTimezone: "Asia/Tokyo",
    });
  });

  it("refuses a fixed repeating wake when the timezone offset changes seasonally", () => {
    expect(
      inspectPowerSchedule(
        config,
        probe("", {
          localTimezone: () => "America/Los_Angeles",
        }),
      ),
    ).toMatchObject({ status: "dynamic-offset" });
  });

  it("is unsupported away from macOS and contains read failures", () => {
    expect(inspectPowerSchedule(config, probe("", { platform: "linux" }))).toMatchObject({
      status: "unsupported",
    });
    expect(
      inspectPowerSchedule(
        config,
        probe("", {
          readSchedule: () => {
            throw new Error("pmset unavailable");
          },
        }),
      ),
    ).toMatchObject({ status: "error", detail: "pmset unavailable" });
  });
});
