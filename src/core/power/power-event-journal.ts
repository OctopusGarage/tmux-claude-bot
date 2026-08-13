import * as fs from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { HostPowerPhase } from "../platform/power-policy.js";

const log = createLogger("power.events");
const EVENT_DIR = "power-events";
const RETENTION_DAYS = 30;

export type PowerEvent =
  | { at: number; kind: "phase-transition"; from: HostPowerPhase | null; to: HostPowerPhase }
  | { at: number; kind: "keep-awake-acquired" | "keep-awake-released" }
  | { at: number; kind: "quiet-release-delayed"; reasons: string[] }
  | { at: number; kind: "degraded"; reason: string };

export type PowerEventRecorder = (event: PowerEvent) => void;

type JournalOptions = { stateDir?: string };

function dateKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10).replaceAll("-", "");
}

function eventDirectory(stateDir = appStateDir()): string {
  return join(stateDir, EVENT_DIR);
}

function isPhase(value: unknown): value is HostPowerPhase {
  return ["unmanaged", "service", "natural-sleep", "wake-warmup"].includes(String(value));
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 300;
}

function parsePowerEvent(value: unknown): PowerEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.at !== "number" || !Number.isFinite(event.at)) return null;
  if (event.kind === "phase-transition") {
    if ((event.from === null || isPhase(event.from)) && isPhase(event.to)) {
      return { at: event.at, kind: event.kind, from: event.from, to: event.to };
    }
    return null;
  }
  if (event.kind === "keep-awake-acquired" || event.kind === "keep-awake-released") {
    return { at: event.at, kind: event.kind };
  }
  if (event.kind === "quiet-release-delayed") {
    if (
      Array.isArray(event.reasons) &&
      event.reasons.length <= 20 &&
      event.reasons.every(isBoundedString)
    ) {
      return { at: event.at, kind: event.kind, reasons: event.reasons };
    }
    return null;
  }
  if (event.kind === "degraded" && isBoundedString(event.reason)) {
    return { at: event.at, kind: event.kind, reason: event.reason };
  }
  return null;
}

function cleanOldJournals(dir: string, relativeTo: number): void {
  const cutoffKey = dateKey(relativeTo - RETENTION_DAYS * 86_400_000);
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^power-(\d{8})\.jsonl$/.exec(name);
      if (match?.[1] !== undefined && match[1] < cutoffKey) fs.unlinkSync(join(dir, name));
    }
  } catch {
    // Retention is best-effort; append/read remains authoritative for this call.
  }
}

export function appendPowerEvent(event: PowerEvent, options: JournalOptions = {}): void {
  const dir = eventDirectory(options.stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(join(dir, `power-${dateKey(event.at)}.jsonl`), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  cleanOldJournals(dir, event.at);
}

export function createPowerEventRecorder(options: JournalOptions = {}): PowerEventRecorder {
  return (event) => {
    try {
      appendPowerEvent(event, options);
    } catch (error) {
      log.warn("power event journal write failed", { err: error });
    }
  };
}

export function readPowerEvents(input: { stateDir?: string; since: number; until: number }): {
  events: PowerEvent[];
  invalidRecords: number;
} {
  const dir = eventDirectory(input.stateDir);
  const firstKey = dateKey(input.since);
  const lastKey = dateKey(input.until);
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => {
        const match = /^power-(\d{8})\.jsonl$/.exec(name);
        return match?.[1] !== undefined && match[1] >= firstKey && match[1] <= lastKey;
      })
      .sort();
  } catch {
    return { events: [], invalidRecords: 0 };
  }

  const events: PowerEvent[] = [];
  let invalidRecords = 0;
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        invalidRecords += 1;
        continue;
      }
      const event = parsePowerEvent(raw);
      if (event === null) {
        invalidRecords += 1;
        continue;
      }
      if (event.at >= input.since && event.at <= input.until) events.push(event);
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, invalidRecords };
}
