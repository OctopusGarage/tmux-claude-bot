import { execFileSync, spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import type { HostPowerConfig } from "../../shared/types.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import { wakeTimeFor } from "./power-policy.js";

export type PowerScheduleProbe = {
  platform: string;
  readSchedule(): string;
  localTimezone(): string;
  now?(): number;
  runPrivileged(args: string[]): void;
};

export type PowerScheduleInspection = {
  status: "verified" | "missing" | "conflict" | "dynamic-offset" | "unsupported" | "error";
  wakeAt: string;
  timezone: string;
  hostWakeAt: string;
  hostTimezone: string;
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

function minutesFor(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function timeFor(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function timezoneOffsetMinutes(timezone: string, instant: number): number {
  const at = Math.floor(instant / 60_000) * 60_000;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const value = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value ?? "0");
  const representedAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
  );
  return (representedAsUtc - at) / 60_000;
}

function stableTimezoneDelta(
  policyTimezone: string,
  hostTimezone: string,
  now: number,
): number | null {
  const deltas = new Set<number>();
  const fourWeeksMs = 28 * 24 * 60 * 60 * 1_000;
  for (let sample = 0; sample <= 14; sample += 1) {
    const at = now + sample * fourWeeksMs;
    deltas.add(timezoneOffsetMinutes(hostTimezone, at) - timezoneOffsetMinutes(policyTimezone, at));
  }
  return deltas.size === 1 ? ([...deltas][0] ?? null) : null;
}

function hostTimezone(): string {
  if (process.platform !== "darwin") return Intl.DateTimeFormat().resolvedOptions().timeZone;

  const marker = "/zoneinfo/";
  const target = readlinkSync("/etc/localtime");
  const markerIndex = target.indexOf(marker);
  if (markerIndex < 0) throw new Error("macOS system timezone is unavailable");
  const timezone = target.slice(markerIndex + marker.length);
  if (!timezone) throw new Error("macOS system timezone is unavailable");
  return timezone;
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
    localTimezone: hostTimezone,
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
  const hostTimezone = probe.localTimezone();
  if (probe.platform !== "darwin") {
    return {
      status: "unsupported",
      wakeAt,
      timezone: config.timezone,
      hostWakeAt: wakeAt,
      hostTimezone,
      detail: "managed wake schedules require macOS",
    };
  }
  try {
    const delta = stableTimezoneDelta(config.timezone, hostTimezone, (probe.now ?? Date.now)());
    if (delta === null) {
      return {
        status: "dynamic-offset",
        wakeAt,
        timezone: config.timezone,
        hostWakeAt: wakeAt,
        hostTimezone,
        detail: `a fixed daily wake cannot preserve ${wakeAt} ${config.timezone} because its offset to ${hostTimezone} changes seasonally`,
      };
    }
    const hostWakeAt = timeFor(minutesFor(wakeAt) + delta);
    const mapping = `${wakeAt} ${config.timezone} maps to ${hostWakeAt} ${hostTimezone}`;
    const repeatingLines = repeatingSection(probe.readSchedule());
    if (repeatingLines.length === 0) {
      return {
        status: "missing",
        wakeAt,
        timezone: config.timezone,
        hostWakeAt,
        hostTimezone,
        detail: `managed daily wake is not installed; ${mapping}`,
      };
    }
    const events = repeatingLines.map(parseRepeatingEvent);
    if (
      events.length === 1 &&
      events[0]?.type === "wake" &&
      events[0].time === hostWakeAt &&
      events[0].recurrence === "day"
    ) {
      return {
        status: "verified",
        wakeAt,
        timezone: config.timezone,
        hostWakeAt,
        hostTimezone,
        detail: `exact managed daily wake is installed; ${mapping}`,
      };
    }
    return {
      status: "conflict",
      wakeAt,
      timezone: config.timezone,
      hostWakeAt,
      hostTimezone,
      detail: `an existing repeating power schedule does not exactly match ${hostWakeAt} ${hostTimezone} (${mapping})`,
    };
  } catch (error) {
    return {
      status: "error",
      wakeAt,
      timezone: config.timezone,
      hostWakeAt: wakeAt,
      hostTimezone,
      detail: safeError(error),
    };
  }
}
