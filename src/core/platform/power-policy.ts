import type { HostPowerConfig } from "../../shared/types.js";

export type HostPowerPhase = "unmanaged" | "service" | "natural-sleep" | "wake-warmup";

export type QuietHoursTrigger =
  | "interactive"
  | "operator"
  | "background"
  | "reconcile"
  | "resource-repair";

export type QuietHoursAdmission =
  | { allowed: true; reason: string }
  | { allowed: false; reason: "quiet-hours" | "wake-warmup"; retryAt: number };

const WAKE_WARMUP_MINUTES = 15;

function minutesFor(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function timeFor(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function isWithinCircularWindow(now: number, start: number, end: number): boolean {
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function localMinutes(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function localDateParts(
  now: number,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  return {
    year: Number(parts.find((part) => part.type === "year")?.value ?? "1970"),
    month: Number(parts.find((part) => part.type === "month")?.value ?? "1"),
    day: Number(parts.find((part) => part.type === "day")?.value ?? "1"),
  };
}

function localDateTimeParts(
  now: number,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  return {
    year: Number(parts.find((part) => part.type === "year")?.value ?? "1970"),
    month: Number(parts.find((part) => part.type === "month")?.value ?? "1"),
    day: Number(parts.find((part) => part.type === "day")?.value ?? "1"),
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0"),
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? "0"),
  };
}

function addCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedWallTimeToEpoch(
  input: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): number {
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localDateTimeParts(candidate, timezone);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const delta = actualUtc - targetUtc;
    if (delta === 0) break;
    candidate -= delta;
  }
  return candidate;
}

export function nextQuietHoursRetryAt(config: HostPowerConfig, now: number): number {
  const targetMinutes = minutesFor(config.quietEnd);
  const currentMinutes = localMinutes(now, config.timezone);
  const targetDate = addCalendarDays(
    localDateParts(now, config.timezone),
    currentMinutes < targetMinutes ? 0 : 1,
  );
  return zonedWallTimeToEpoch(
    {
      ...targetDate,
      hour: Math.floor(targetMinutes / 60),
      minute: targetMinutes % 60,
    },
    config.timezone,
  );
}

export function wakeTimeFor(config: HostPowerConfig): string {
  return timeFor(minutesFor(config.quietEnd) - WAKE_WARMUP_MINUTES);
}

export function resolveHostPowerPhase(config: HostPowerConfig, now: number): HostPowerPhase {
  if (config.mode === "off") return "unmanaged";
  if (config.mode === "always") return "service";

  const minute = localMinutes(now, config.timezone);
  const quietStart = minutesFor(config.quietStart);
  const quietEnd = minutesFor(config.quietEnd);
  const wakeAt = minutesFor(wakeTimeFor(config));
  if (isWithinCircularWindow(minute, quietStart, wakeAt)) return "natural-sleep";
  if (isWithinCircularWindow(minute, wakeAt, quietEnd)) return "wake-warmup";
  return "service";
}

export function admitQuietHoursWork(
  config: HostPowerConfig,
  input: { trigger: QuietHoursTrigger; now: number },
): QuietHoursAdmission {
  if (
    input.trigger === "interactive" ||
    input.trigger === "operator" ||
    input.trigger === "reconcile"
  ) {
    return { allowed: true, reason: input.trigger };
  }
  const phase = resolveHostPowerPhase(config, input.now);
  if (phase === "natural-sleep")
    return {
      allowed: false,
      reason: "quiet-hours",
      retryAt: nextQuietHoursRetryAt(config, input.now),
    };
  if (phase === "wake-warmup")
    return {
      allowed: false,
      reason: "wake-warmup",
      retryAt: nextQuietHoursRetryAt(config, input.now),
    };
  return { allowed: true, reason: phase };
}
