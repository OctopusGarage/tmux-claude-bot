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
  | { allowed: false; reason: "quiet-hours" | "wake-warmup" };

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
  if (phase === "natural-sleep") return { allowed: false, reason: "quiet-hours" };
  if (phase === "wake-warmup") return { allowed: false, reason: "wake-warmup" };
  return { allowed: true, reason: phase };
}
