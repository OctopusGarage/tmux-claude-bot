import { describe, expect, it, vi } from "vitest";
import { runPowerCommand } from "../../src/core/platform/power-command.js";
import type { PowerScheduleProbe } from "../../src/core/platform/power-schedule.js";
import type { HostPowerConfig } from "../../src/shared/types.js";

const config: HostPowerConfig = {
  mode: "scheduled",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};

function probe(outputs: string[]): PowerScheduleProbe {
  return {
    platform: "darwin",
    readSchedule: vi.fn(() => outputs.shift() ?? ""),
    localTimezone: () => "Asia/Singapore",
    now: () => Date.parse("2026-08-11T00:00:00Z"),
    runPrivileged: vi.fn(),
  };
}

describe("power command", () => {
  it("does not inspect a wake schedule when the current mode does not require one", () => {
    const scheduleProbe = probe([]);
    const result = runPowerCommand(["status", "--json"], {
      config: { ...config, mode: "always" },
      probe: scheduleProbe,
      readPowerSource: () => "battery",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "null")).toMatchObject({
      mode: "always",
      powerSource: "battery",
      degradedReason: "host is on battery; caffeinate -s does not prevent system sleep",
      schedule: { status: "not-required" },
    });
    expect(scheduleProbe.readSchedule).not.toHaveBeenCalled();
  });

  it("renders bounded JSON status", () => {
    const result = runPowerCommand(["status", "--json"], {
      config,
      now: () => Date.parse("2026-08-11T01:00:00+08:00"),
      probe: probe(["Repeating power events:\n  wake at 9:15AM every day\n"]),
      readPowerSource: () => "ac",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "null")).toMatchObject({
      mode: "scheduled",
      phase: "service",
      quietStart: "02:00",
      wakeAt: "09:15",
      quietEnd: "09:30",
      powerSource: "ac",
      degradedReason: null,
      schedule: { status: "verified" },
    });
  });

  it("installs only after a missing check and verifies afterwards", () => {
    const scheduleProbe = probe([
      "Scheduled power events:\n",
      "Repeating power events:\n  wake at 9:15AM every day\n",
    ]);
    const result = runPowerCommand(["schedule", "install"], { config, probe: scheduleProbe });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(scheduleProbe.runPrivileged).toHaveBeenCalledWith([
      "repeat",
      "wake",
      "MTWRFSU",
      "09:15:00",
    ]);
  });

  it("installs the Singapore wake translated to the Tokyo host clock", () => {
    const scheduleProbe = probe([
      "Scheduled power events:\n",
      "Repeating power events:\n  wake at 10:15AM every day\n",
    ]);
    scheduleProbe.localTimezone = () => "Asia/Tokyo";
    const result = runPowerCommand(["schedule", "install"], { config, probe: scheduleProbe });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("09:15 Asia/Singapore");
    expect(result.stdout).toContain("10:15 Asia/Tokyo");
    expect(scheduleProbe.runPrivileged).toHaveBeenCalledWith([
      "repeat",
      "wake",
      "MTWRFSU",
      "10:15:00",
    ]);
  });

  it("refuses to overwrite a conflict", () => {
    const scheduleProbe = probe(["Repeating power events:\n  wake at 8:00AM every day\n"]);
    const result = runPowerCommand(["schedule", "install"], { config, probe: scheduleProbe });
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toMatch(/conflict/i);
    expect(scheduleProbe.runPrivileged).not.toHaveBeenCalled();
  });

  it("removes only the exact managed event", () => {
    const exactProbe = probe([
      "Repeating power events:\n  wake at 9:15AM every day\n",
      "Scheduled power events:\n",
    ]);
    expect(runPowerCommand(["schedule", "remove"], { config, probe: exactProbe })).toMatchObject({
      exitCode: 0,
    });
    expect(exactProbe.runPrivileged).toHaveBeenCalledWith(["repeat", "cancel"]);

    const conflictProbe = probe(["Repeating power events:\n  wake at 8:00AM every day\n"]);
    expect(runPowerCommand(["schedule", "remove"], { config, probe: conflictProbe })).toMatchObject(
      {
        exitCode: 1,
      },
    );
    expect(conflictProbe.runPrivileged).not.toHaveBeenCalled();
  });

  it("requires scheduled mode for schedule mutation", () => {
    const scheduleProbe = probe([]);
    expect(
      runPowerCommand(["schedule", "install"], {
        config: { ...config, mode: "off" },
        probe: scheduleProbe,
      }),
    ).toMatchObject({ exitCode: 1 });
    expect(scheduleProbe.readSchedule).not.toHaveBeenCalled();
  });
});
