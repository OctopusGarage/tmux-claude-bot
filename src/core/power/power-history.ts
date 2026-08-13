import { execFileSync } from "node:child_process";
import type { HostPowerConfig } from "../../shared/types.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import { wakeTimeFor } from "../platform/power-policy.js";
import { type PowerEvent, readPowerEvents } from "./power-event-journal.js";

const MAX_EVENTS = 200;

export type SystemPowerEvidence =
  | { status: "available"; detail: string }
  | { status: "unsupported" | "failed" | "parse-failed"; detail: string };

export type SystemPowerProbeResult =
  | { status: "available"; output: string; detail: string }
  | { status: "unsupported" | "failed"; detail: string };

export type PowerHistoryEvent = {
  at: number;
  source: "tcb" | "macos";
  code: PowerEvent["kind"] | "macos-sleep" | "macos-dark-wake" | "macos-wake";
  detail: string;
};

export type PowerHistoryCheck = {
  code:
    | "quiet-release"
    | "natural-sleep"
    | "scheduled-wake"
    | "keep-awake-reacquire"
    | "service-resume";
  status: "passed" | "not-observed" | "incomplete" | "degraded";
  detail: string;
};

export type PowerHistoryReport = {
  window: { since: number; until: number };
  policy: {
    mode: HostPowerConfig["mode"];
    timezone: string;
    quietStart: string;
    wakeAt: string;
    quietEnd: string;
  };
  status: "complete" | "incomplete" | "degraded";
  systemEvidence: SystemPowerEvidence;
  checks: PowerHistoryCheck[];
  events: PowerHistoryEvent[];
  invalidApplicationRecords: number;
  truncated: boolean;
};

export type PowerHistoryProbe = () => SystemPowerProbeResult;

export function createSystemPowerHistoryProbe(platform = process.platform): PowerHistoryProbe {
  return () => {
    if (platform !== "darwin") {
      return { status: "unsupported", detail: "macOS power history is unavailable on this host" };
    }
    try {
      return {
        status: "available",
        output: execFileSync("/usr/bin/pmset", ["-g", "log"], {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 8 * 1024 * 1024,
        }),
        detail: "read-only pmset power history",
      };
    } catch {
      return { status: "failed", detail: "macOS power history probe failed" };
    }
  };
}

function parseTimestamp(date: string, time: string, offset: string): number | null {
  const normalizedOffset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const parsed = Date.parse(`${date}T${time}${normalizedOffset}`);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseSystemEvents(
  output: string,
  since: number,
  until: number,
): { events: PowerHistoryEvent[]; recognized: number } {
  const events: PowerHistoryEvent[] = [];
  let recognized = 0;
  const pattern =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\s+(Sleep|DarkWake|Wake)\s{2,}(.+)$/;
  for (const line of output.split("\n")) {
    const match = pattern.exec(line);
    if (!match) continue;
    const [, date = "", time = "", offset = "", kind = "", message = ""] = match;
    const at = parseTimestamp(date, time, offset);
    if (at === null) continue;
    if (kind === "Sleep" && !message.startsWith("Entering Sleep state")) continue;
    recognized += 1;
    if (at < since || at > until) continue;
    const code =
      kind === "Sleep" ? "macos-sleep" : kind === "DarkWake" ? "macos-dark-wake" : "macos-wake";
    events.push({
      at,
      source: "macos",
      code,
      detail: tildeifyHome(message.trim()).slice(0, 300),
    });
  }
  return { events, recognized };
}

function tcbEventView(event: PowerEvent): PowerHistoryEvent {
  if (event.kind === "phase-transition") {
    return {
      at: event.at,
      source: "tcb",
      code: event.kind,
      detail: `${event.from ?? "startup"} -> ${event.to}`,
    };
  }
  if (event.kind === "quiet-release-delayed") {
    return { at: event.at, source: "tcb", code: event.kind, detail: event.reasons.join(", ") };
  }
  if (event.kind === "degraded") {
    return {
      at: event.at,
      source: "tcb",
      code: event.kind,
      detail: tildeifyHome(event.reason),
    };
  }
  return { at: event.at, source: "tcb", code: event.kind, detail: event.kind };
}

function localMinutes(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  return (
    Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value ?? 0)
  );
}

function localDateKey(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const value = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function previousDateKey(value: string): string {
  const [year = 0, month = 1, day = 1] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function clockMinutes(value: string): number {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function nearClock(at: number, clock: string, timezone: string, toleranceMinutes = 2): boolean {
  const difference = Math.abs(localMinutes(at, timezone) - clockMinutes(clock));
  return Math.min(difference, 1440 - difference) <= toleranceMinutes;
}

function quietCycleKey(at: number, config: HostPowerConfig): string | null {
  const minute = localMinutes(at, config.timezone);
  const start = clockMinutes(config.quietStart);
  const end = clockMinutes(config.quietEnd);
  const date = localDateKey(at, config.timezone);
  if (start <= end) return minute >= start && minute <= end + 5 ? date : null;
  if (minute >= start) return date;
  if (minute <= end + 5) return previousDateKey(date);
  return null;
}

function check(
  code: PowerHistoryCheck["code"],
  status: PowerHistoryCheck["status"],
  detail: string,
): PowerHistoryCheck {
  return { code, status, detail };
}

export function readPowerHistory(input: {
  config: HostPowerConfig;
  since: number;
  until: number;
  readEvents?: typeof readPowerEvents;
  probe?: PowerHistoryProbe;
}): PowerHistoryReport {
  const application = (input.readEvents ?? readPowerEvents)({
    since: input.since,
    until: input.until,
  });
  const probed = (input.probe ?? createSystemPowerHistoryProbe())();
  let systemEvidence: SystemPowerEvidence = probed;
  let systemEvents: PowerHistoryEvent[] = [];
  if (probed.status === "available") {
    const parsed = parseSystemEvents(probed.output, input.since, input.until);
    if (probed.output.trim() !== "" && parsed.recognized === 0) {
      systemEvidence = { status: "parse-failed", detail: "macOS power history was not parseable" };
    } else {
      systemEvents = parsed.events;
      systemEvidence = { status: "available", detail: probed.detail };
    }
  }

  const wakeClock = wakeTimeFor(input.config);
  const cycleKeys = [
    ...application.events
      .filter(
        (event) =>
          event.kind === "keep-awake-released" ||
          (event.kind === "phase-transition" && event.to === "service"),
      )
      .map((event) => quietCycleKey(event.at, input.config)),
    ...systemEvents
      .filter(
        (event) =>
          event.code === "macos-wake" && nearClock(event.at, wakeClock, input.config.timezone),
      )
      .map((event) => quietCycleKey(event.at, input.config)),
  ].filter((key): key is string => key !== null);
  const selectedCycle = cycleKeys.sort().at(-1) ?? null;
  const inSelectedCycle = (at: number): boolean =>
    selectedCycle !== null && quietCycleKey(at, input.config) === selectedCycle;
  const release = application.events.find(
    (event) => event.kind === "keep-awake-released" && inSelectedCycle(event.at),
  );
  const scheduledWake = systemEvents.find(
    (event) =>
      event.code === "macos-wake" &&
      inSelectedCycle(event.at) &&
      nearClock(event.at, wakeClock, input.config.timezone),
  );
  const sleep =
    release === undefined
      ? undefined
      : systemEvents.find(
          (event) =>
            event.code === "macos-sleep" &&
            inSelectedCycle(event.at) &&
            event.at >= release.at &&
            (scheduledWake === undefined || event.at <= scheduledWake.at),
        );
  const reacquire = application.events.find(
    (event) =>
      event.kind === "keep-awake-acquired" &&
      scheduledWake !== undefined &&
      inSelectedCycle(event.at) &&
      event.at >= scheduledWake.at,
  );
  const resumed = application.events.find(
    (event) =>
      event.kind === "phase-transition" &&
      event.to === "service" &&
      inSelectedCycle(event.at) &&
      nearClock(event.at, input.config.quietEnd, input.config.timezone, 5),
  );
  const checks: PowerHistoryCheck[] = [
    release
      ? check("quiet-release", "passed", "TCB released keep-awake during the window")
      : check("quiet-release", "incomplete", "no TCB keep-awake release evidence"),
    sleep
      ? check("natural-sleep", "passed", "macOS entered natural sleep after release")
      : release
        ? check("natural-sleep", "not-observed", "release occurred; macOS did not choose sleep")
        : check(
            "natural-sleep",
            "incomplete",
            "sleep cannot be correlated without release evidence",
          ),
    systemEvidence.status !== "available"
      ? check("scheduled-wake", "incomplete", "macOS wake evidence is unavailable")
      : scheduledWake
        ? check("scheduled-wake", "passed", "full wake observed near the configured wake time")
        : check("scheduled-wake", "incomplete", "no full wake near the configured wake time"),
    reacquire
      ? check("keep-awake-reacquire", "passed", "TCB reacquired keep-awake after wake")
      : check("keep-awake-reacquire", "incomplete", "no post-wake reacquisition evidence"),
    resumed
      ? check("service-resume", "passed", "TCB entered service phase near quiet end")
      : check("service-resume", "incomplete", "no service-phase resume evidence"),
  ];

  const allEvents = [...application.events.map(tcbEventView), ...systemEvents].sort(
    (a, b) => a.at - b.at,
  );
  const truncated = allEvents.length > MAX_EVENTS;
  const events = truncated ? allEvents.slice(-MAX_EVENTS) : allEvents;
  const status = application.events.some((event) => event.kind === "degraded")
    ? "degraded"
    : checks.some((item) => item.status === "incomplete")
      ? "incomplete"
      : "complete";
  return {
    window: { since: input.since, until: input.until },
    policy: {
      mode: input.config.mode,
      timezone: input.config.timezone,
      quietStart: input.config.quietStart,
      wakeAt: wakeTimeFor(input.config),
      quietEnd: input.config.quietEnd,
    },
    status,
    systemEvidence,
    checks,
    events,
    invalidApplicationRecords: application.invalidRecords,
    truncated,
  };
}
