import { execFileSync, spawnSync } from "node:child_process";
import type { HostPowerConfig } from "../../shared/types.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import { wakeTimeFor } from "./power-policy.js";

export type PowerScheduleProbe = {
  platform: string;
  readSchedule(): string;
  localTimezone(): string;
  runPrivileged(args: string[]): void;
};

export type PowerScheduleInspection = {
  status: "verified" | "missing" | "conflict" | "timezone-mismatch" | "unsupported" | "error";
  wakeAt: string;
  timezone: string;
  detail: string;
};

type RepeatingEvent = { type: string; time: string; recurrence: string };

function normalizeTwelveHourTime(hourText: string, minuteText: string, period: string): string {
  const rawHour = Number(hourText);
  const hour = period.toUpperCase() === "AM" ? rawHour % 12 : (rawHour % 12) + 12;
  return `${String(hour).padStart(2, "0")}:${minuteText}`;
}

function repeatingSection(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => /^Repeating power events:/i.test(line.trim()));
  if (header < 0) return [];
  const inline = lines[header]?.replace(/^.*?:/, "").trim();
  const section: string[] = inline && !/^none$/i.test(inline) ? [inline] : [];
  for (const line of lines.slice(header + 1)) {
    const trimmed = line.trim();
    if (/^[A-Za-z][^:]*events:/i.test(trimmed)) break;
    if (trimmed && !/^none$/i.test(trimmed)) section.push(trimmed);
  }
  return section;
}

function parseRepeatingEvent(line: string): RepeatingEvent | null {
  const match = line.match(
    /^(wake|wakeorpoweron|poweron|sleep|shutdown)\s+at\s+(\d{1,2}):(\d{2})(AM|PM)\s+every\s+(.+)$/i,
  );
  if (!match) return null;
  return {
    type: match[1]?.toLowerCase() ?? "",
    time: normalizeTwelveHourTime(match[2] ?? "0", match[3] ?? "00", match[4] ?? "AM"),
    recurrence: match[5]?.toLowerCase() ?? "",
  };
}

function safeError(error: unknown): string {
  return tildeifyHome(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function createPowerScheduleProbe(): PowerScheduleProbe {
  return {
    platform: process.platform,
    readSchedule: () =>
      execFileSync("pmset", ["-g", "sched"], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }),
    localTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    runPrivileged: (args) => {
      const result = spawnSync("sudo", ["pmset", ...args], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`sudo pmset exited with status ${result.status}`);
    },
  };
}

/** Runtime-safe inspection: this function never mutates the host or requests privileges. */
export function inspectPowerSchedule(
  config: HostPowerConfig,
  probe: PowerScheduleProbe = createPowerScheduleProbe(),
): PowerScheduleInspection {
  const wakeAt = wakeTimeFor(config);
  if (probe.platform !== "darwin") {
    return {
      status: "unsupported",
      wakeAt,
      timezone: config.timezone,
      detail: "managed wake schedules require macOS",
    };
  }
  const localTimezone = probe.localTimezone();
  if (localTimezone !== config.timezone) {
    return {
      status: "timezone-mismatch",
      wakeAt,
      timezone: config.timezone,
      detail: `macOS timezone is ${localTimezone}; configured timezone is ${config.timezone}`,
    };
  }
  try {
    const repeatingLines = repeatingSection(probe.readSchedule());
    if (repeatingLines.length === 0) {
      return {
        status: "missing",
        wakeAt,
        timezone: config.timezone,
        detail: "managed daily wake is not installed",
      };
    }
    const events = repeatingLines.map(parseRepeatingEvent);
    if (
      events.length === 1 &&
      events[0]?.type === "wake" &&
      events[0].time === wakeAt &&
      events[0].recurrence === "day"
    ) {
      return {
        status: "verified",
        wakeAt,
        timezone: config.timezone,
        detail: "exact managed daily wake is installed",
      };
    }
    return {
      status: "conflict",
      wakeAt,
      timezone: config.timezone,
      detail: "an existing repeating power schedule does not exactly match the managed wake",
    };
  } catch (error) {
    return {
      status: "error",
      wakeAt,
      timezone: config.timezone,
      detail: safeError(error),
    };
  }
}
