import * as fs from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { AgentKind } from "../agents/types.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import type { ResourceAdmissionInput } from "../resource-guardian/types.js";

const log = createLogger("automation.admission-events");
const EVENT_DIR = "automation-admission/events";
const DEDUPE_FILE = "automation-admission/event-dedupe.json";
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEDUPE_MS = 15 * 60_000;
const SOURCES = new Set<ResourceAdmissionInput["source"]>([
  "loop-engineering",
  "daily-task-audit",
  "runtime-guardian",
  "project-recovery",
  "autopilot-delegate",
  "resource-guardian",
]);

export type AutomationAdmissionEvent = {
  schemaVersion: 1;
  at: number;
  kind: "planned" | "superseded" | "deferred" | "admitted" | "settled" | "capacity-transition";
  source: ResourceAdmissionInput["source"];
  intentId: string;
  agent?: AgentKind;
  occurrenceId?: string;
  reason: string;
  retryAt?: number;
};

export type NewAutomationAdmissionEvent = Omit<AutomationAdmissionEvent, "schemaVersion">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = 300): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseEvent(value: unknown): AutomationAdmissionEvent | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
  if (
    !["planned", "superseded", "deferred", "admitted", "settled", "capacity-transition"].includes(
      String(value.kind),
    ) ||
    !boundedString(value.source, 80) ||
    !SOURCES.has(value.source as ResourceAdmissionInput["source"]) ||
    !boundedString(value.intentId) ||
    !boundedString(value.reason)
  ) {
    return null;
  }
  if (value.agent !== undefined && value.agent !== "claude" && value.agent !== "codex") return null;
  if (value.occurrenceId !== undefined && !boundedString(value.occurrenceId)) return null;
  if (
    value.retryAt !== undefined &&
    (typeof value.retryAt !== "number" || !Number.isFinite(value.retryAt))
  )
    return null;
  return value as AutomationAdmissionEvent;
}

function dateKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10).replaceAll("-", "");
}

function eventDir(): string {
  return join(appStateDir(), EVENT_DIR);
}

function dedupeKey(event: NewAutomationAdmissionEvent): string {
  return [
    event.kind,
    event.source,
    event.intentId,
    event.agent ?? "",
    event.reason,
    event.retryAt ?? "",
  ].join("|");
}

function cleanOldFiles(dir: string, now: number): void {
  const cutoff = dateKey(now - RETENTION_MS);
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^(\d{8})\.jsonl$/.exec(name);
      if (match?.[1] !== undefined && match[1] < cutoff) fs.unlinkSync(join(dir, name));
    }
  } catch {
    // Retention is best effort; admission authority never depends on this journal.
  }
}

function cleanOldDedupeEntries(dedupe: JsonMapStore<{ at: number }>, now: number): void {
  for (const [key, value] of dedupe.sortedEntries()) {
    if (!Number.isFinite(value.at) || value.at > now || now - value.at > RETENTION_MS) {
      dedupe.delete(key);
    }
  }
}

export function appendAutomationAdmissionEvent(event: NewAutomationAdmissionEvent): boolean {
  const fingerprint = dedupeKey(event);
  const dedupe = new JsonMapStore<{ at: number }>(DEDUPE_FILE);
  const previous = dedupe.get(fingerprint);
  if (previous !== undefined && event.at >= previous.at && event.at - previous.at < DEDUPE_MS) {
    return false;
  }
  const value: AutomationAdmissionEvent = { schemaVersion: 1, ...event };
  const dir = eventDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(join(dir, `${dateKey(event.at)}.jsonl`), `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    dedupe.set(fingerprint, { at: event.at });
    cleanOldDedupeEntries(dedupe, event.at);
    cleanOldFiles(dir, event.at);
    return true;
  } catch (error) {
    log.warn("automation admission event write failed", { err: error });
    return false;
  }
}

export function readAutomationAdmissionEvents(input: {
  since: number;
  until: number;
  limit?: number;
}): { events: AutomationAdmissionEvent[]; invalidRecords: number; truncated: boolean } {
  const first = dateKey(input.since);
  const last = dateKey(input.until);
  let files: string[];
  try {
    files = fs
      .readdirSync(eventDir())
      .filter((name) => {
        const match = /^(\d{8})\.jsonl$/.exec(name);
        return match?.[1] !== undefined && match[1] >= first && match[1] <= last;
      })
      .sort();
  } catch {
    return { events: [], invalidRecords: 0, truncated: false };
  }
  const events: AutomationAdmissionEvent[] = [];
  let invalidRecords = 0;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(join(eventDir(), file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const event = parseEvent(JSON.parse(line));
        if (event === null) invalidRecords += 1;
        else if (event.at >= input.since && event.at <= input.until) events.push(event);
      } catch {
        invalidRecords += 1;
      }
    }
  }
  events.sort((left, right) => left.at - right.at);
  const limit = Math.max(1, Math.min(200, input.limit ?? 200));
  return {
    events: events.slice(-limit),
    invalidRecords,
    truncated: events.length > limit,
  };
}
