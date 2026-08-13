import { describe, expect, it } from "vitest";
import type { PowerEvent } from "../../src/core/power/power-event-journal.js";
import { readPowerHistory } from "../../src/core/power/power-history.js";
import type { HostPowerConfig } from "../../src/shared/types.js";

const config: HostPowerConfig = {
  mode: "scheduled",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};
const at = (local: string): number => Date.parse(`${local}+08:00`);

function history(
  events: PowerEvent[],
  output: string,
  probeStatus: "available" | "unsupported" | "failed" = "available",
) {
  return readPowerHistory({
    config,
    since: at("2026-08-12T01:30:00"),
    until: at("2026-08-12T10:00:00"),
    readEvents: () => ({ events, invalidRecords: 0 }),
    probe: () =>
      probeStatus === "available"
        ? { status: "available", output, detail: "pmset log read" }
        : { status: probeStatus, detail: "host evidence unavailable" },
  });
}

describe("host power history", () => {
  it("correlates a known-good quiet release, natural sleep, scheduled wake, and resume", () => {
    const events: PowerEvent[] = [
      {
        at: at("2026-08-12T02:00:00"),
        kind: "phase-transition",
        from: "service",
        to: "natural-sleep",
      },
      { at: at("2026-08-12T02:00:12"), kind: "keep-awake-released" },
      {
        at: at("2026-08-12T09:15:00"),
        kind: "phase-transition",
        from: "natural-sleep",
        to: "wake-warmup",
      },
      { at: at("2026-08-12T09:15:00"), kind: "keep-awake-acquired" },
      {
        at: at("2026-08-12T09:30:00"),
        kind: "phase-transition",
        from: "wake-warmup",
        to: "service",
      },
    ];
    const report = history(
      events,
      [
        "2026-08-12 02:37:10 +0800 Sleep                Entering Sleep state due to 'Sleep Service Back to Sleep'",
        "2026-08-12 08:55:00 +0800 Sleep                Entering DarkWake state due to 'Idle Sleep'",
        "2026-08-12 09:14:35 +0800 Wake Requests        [process=powerd request=UserWake wakeAt=2026-08-12 09:15:00]",
        "2026-08-12 08:56:54 +0800 DarkWake             DarkWake from Deep Idle due to Maintenance",
        "2026-08-12 09:15:00 +0800 Wake                 Wake from Deep Idle due to rtc/HID Activity",
      ].join("\n"),
    );

    expect(report.systemEvidence.status).toBe("available");
    expect(Object.fromEntries(report.checks.map((check) => [check.code, check.status]))).toEqual({
      "quiet-release": "passed",
      "natural-sleep": "passed",
      "scheduled-wake": "passed",
      "keep-awake-reacquire": "passed",
      "service-resume": "passed",
    });
    expect(report.events.map((event) => event.code)).toContain("macos-dark-wake");
    expect(report.events.map((event) => event.code)).toContain("macos-wake");
    expect(report.events.filter((event) => event.code === "macos-wake")).toHaveLength(1);
    expect(report.events.filter((event) => event.code === "macos-sleep")).toHaveLength(1);
    expect(report.events.map((event) => event.at)).toEqual(
      [...report.events.map((event) => event.at)].sort((a, b) => a - b),
    );
  });

  it("does not treat optional natural sleep as failed when release was observed", () => {
    const report = history(
      [{ at: at("2026-08-12T02:00:12"), kind: "keep-awake-released" }],
      "2026-08-12 09:15:00 +0800 Wake                 Wake from Deep Idle due to rtc/HID Activity",
    );
    expect(report.checks.find((check) => check.code === "natural-sleep")?.status).toBe(
      "not-observed",
    );
  });

  it("preserves TCB evidence and reports unavailable host evidence as incomplete", () => {
    const report = history(
      [{ at: at("2026-08-12T02:00:12"), kind: "keep-awake-released" }],
      "",
      "unsupported",
    );
    expect(report.events).toHaveLength(1);
    expect(report.systemEvidence.status).toBe("unsupported");
    expect(report.checks.find((check) => check.code === "scheduled-wake")?.status).toBe(
      "incomplete",
    );
  });

  it("marks an unusable nonempty host response as parse-failed", () => {
    const report = history([], "unexpected pmset output");
    expect(report.systemEvidence.status).toBe("parse-failed");
  });

  it("does not combine evidence from different quiet windows", () => {
    const report = readPowerHistory({
      config,
      since: at("2026-08-11T01:30:00"),
      until: at("2026-08-12T10:00:00"),
      readEvents: () => ({
        invalidRecords: 0,
        events: [
          { at: at("2026-08-11T02:00:12"), kind: "keep-awake-released" },
          { at: at("2026-08-12T09:15:00"), kind: "keep-awake-acquired" },
          {
            at: at("2026-08-12T09:30:00"),
            kind: "phase-transition",
            from: "wake-warmup",
            to: "service",
          },
        ],
      }),
      probe: () => ({
        status: "available",
        detail: "pmset log read",
        output: [
          "2026-08-11 02:30:00 +0800 Sleep                Entering Sleep state due to 'Idle Sleep'",
          "2026-08-12 09:15:00 +0800 Wake                 Wake from Deep Idle due to rtc/HID Activity",
        ].join("\n"),
      }),
    });

    expect(Object.fromEntries(report.checks.map((check) => [check.code, check.status]))).toEqual({
      "quiet-release": "incomplete",
      "natural-sleep": "incomplete",
      "scheduled-wake": "passed",
      "keep-awake-reacquire": "passed",
      "service-resume": "passed",
    });
  });

  it("keeps the newest 200 merged events and declares truncation", () => {
    const events: PowerEvent[] = Array.from({ length: 205 }, (_, index) => ({
      at: at("2026-08-12T02:00:00") + index,
      kind: "degraded" as const,
      reason: `reason-${index}`,
    }));
    const report = history(
      events,
      "2026-08-12 09:15:00 +0800 Wake                 Wake from Deep Idle due to rtc/HID Activity",
    );
    expect(report.truncated).toBe(true);
    expect(report.events).toHaveLength(200);
    expect(report.events[0]?.at).toBe(events[6]?.at);
  });
});
