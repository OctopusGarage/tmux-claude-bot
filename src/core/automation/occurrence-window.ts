import { randomInt } from "node:crypto";
import { JsonMapStore } from "../infra/json-map-store.js";
import type { ResourceAdmissionInput } from "../resource-guardian/types.js";
import { appendAutomationAdmissionEvent } from "./admission-events.js";

export type AutomationOccurrenceStatus = "planned" | "admitted" | "settled" | "superseded";

export type AutomationOccurrence = {
  schemaVersion: 1;
  id: string;
  key: string;
  scheduledAt: number;
  notBefore: number;
  status: AutomationOccurrenceStatus;
  retainedBy?: string;
  updatedAt: number;
};

export type PlanAutomationOccurrenceInput = {
  key: string;
  scheduledAt: number;
  windowMs: number;
  now: number;
  source?: ResourceAdmissionInput["source"];
};

type OccurrenceStoreOptions = {
  randomOffset?: (maxInclusive: number) => number;
};

const FILE = "automation-admission/occurrences.json";
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OPEN_RETENTION_MS = 90 * 24 * 60 * 60_000;

export function automationOccurrenceId(key: string, scheduledAt: number): string {
  return `${key}@${scheduledAt}`;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOccurrence(value: unknown): value is AutomationOccurrence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    typeof record.key === "string" &&
    isFiniteNonNegative(record.scheduledAt) &&
    isFiniteNonNegative(record.notBefore) &&
    ["planned", "admitted", "settled", "superseded"].includes(String(record.status)) &&
    (record.retainedBy === undefined || typeof record.retainedBy === "string") &&
    isFiniteNonNegative(record.updatedAt)
  );
}

/**
 * Durable execution-window authority. The random offset is drawn only for a new
 * occurrence identity; later ticks and process restarts reuse the persisted time.
 */
export class AutomationOccurrenceStore {
  private readonly records = new JsonMapStore<AutomationOccurrence>(FILE);
  private readonly randomOffset: (maxInclusive: number) => number;

  constructor(options: OccurrenceStoreOptions = {}) {
    this.randomOffset = options.randomOffset ?? ((maxInclusive) => randomInt(maxInclusive + 1));
  }

  plan(input: PlanAutomationOccurrenceInput): AutomationOccurrence {
    this.prune(input.now);
    const id = automationOccurrenceId(input.key, input.scheduledAt);
    const existing = this.get(id);
    if (existing !== undefined) return existing;

    const windowMs = Math.max(0, Math.floor(input.windowMs));
    const drawn = windowMs === 0 ? 0 : this.randomOffset(windowMs);
    const offset = Math.min(windowMs, Math.max(0, Math.floor(drawn)));
    const occurrence: AutomationOccurrence = {
      schemaVersion: 1,
      id,
      key: input.key,
      scheduledAt: input.scheduledAt,
      notBefore: input.scheduledAt + offset,
      status: "planned",
      updatedAt: input.now,
    };

    for (const older of this.list()) {
      if (
        older.key !== input.key ||
        older.status !== "planned" ||
        older.scheduledAt >= input.scheduledAt
      ) {
        continue;
      }
      this.records.set(older.id, {
        ...older,
        status: "superseded",
        retainedBy: id,
        updatedAt: input.now,
      });
      if (input.source !== undefined) {
        appendAutomationAdmissionEvent({
          at: input.now,
          kind: "superseded",
          source: input.source,
          intentId: older.id,
          occurrenceId: older.id,
          reason: `retained-by:${id}`,
        });
      }
    }
    this.records.set(id, occurrence);
    if (input.source !== undefined) {
      appendAutomationAdmissionEvent({
        at: input.now,
        kind: "planned",
        source: input.source,
        intentId: id,
        occurrenceId: id,
        reason: "execution-window-planned",
        retryAt: occurrence.notBefore,
      });
    }
    return occurrence;
  }

  get(id: string): AutomationOccurrence | undefined {
    const value = this.records.get(id);
    return isOccurrence(value) ? value : undefined;
  }

  list(): AutomationOccurrence[] {
    return this.records
      .sortedEntries()
      .map(([, value]) => value)
      .filter(isOccurrence)
      .sort(
        (left, right) => left.scheduledAt - right.scheduledAt || left.id.localeCompare(right.id),
      );
  }

  setStatus(
    id: string,
    status: Extract<AutomationOccurrenceStatus, "admitted" | "settled">,
    now: number,
  ): boolean {
    const existing = this.get(id);
    if (existing === undefined || existing.status === "superseded") return false;
    this.records.set(id, { ...existing, status, updatedAt: now });
    return true;
  }

  prune(now: number): number {
    let deleted = 0;
    for (const occurrence of this.list()) {
      const retention =
        occurrence.status === "settled" || occurrence.status === "superseded"
          ? TERMINAL_RETENTION_MS
          : OPEN_RETENTION_MS;
      if (occurrence.updatedAt > now || now - occurrence.updatedAt <= retention) continue;
      if (this.records.delete(occurrence.id)) deleted++;
    }
    return deleted;
  }
}
