import type { AgentKind } from "../agents/types.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import type { AgentCapacityObservation, AgentCapacityView } from "./capacity.js";

type AgentCapacityRecord = {
  schemaVersion: 1;
  observation: AgentCapacityObservation;
  leases: Record<string, { acquiredAt: number; expiresAt: number }>;
  lastAutonomousStartAt: number | null;
};

const FILE = "automation-admission/current.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isCapacityRecord(value: unknown): value is AgentCapacityRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.observation)) return false;
  const observation = value.observation;
  return (
    (observation.agent === "claude" || observation.agent === "codex") &&
    ["subscription", "usage-based", "unknown"].includes(String(observation.authentication)) &&
    ["available", "constrained", "exhausted", "unknown"].includes(String(observation.state)) &&
    isNullableFiniteNumber(observation.fiveHourPct) &&
    isNullableFiniteNumber(observation.weeklyPct) &&
    isNullableFiniteNumber(observation.resetAt) &&
    typeof observation.observedAt === "number" &&
    Number.isFinite(observation.observedAt) &&
    typeof observation.nextProbeAt === "number" &&
    Number.isFinite(observation.nextProbeAt) &&
    typeof observation.latestReason === "string" &&
    isRecord(value.leases) &&
    Object.values(value.leases).every(
      (lease) =>
        isRecord(lease) &&
        typeof lease.acquiredAt === "number" &&
        Number.isFinite(lease.acquiredAt) &&
        typeof lease.expiresAt === "number" &&
        Number.isFinite(lease.expiresAt),
    ) &&
    (value.lastAutonomousStartAt === null ||
      (typeof value.lastAutonomousStartAt === "number" &&
        Number.isFinite(value.lastAutonomousStartAt)))
  );
}

function fallback(agent: AgentKind, reason: string): AgentCapacityView {
  return {
    agent,
    authentication: "unknown",
    state: "unknown",
    fiveHourPct: null,
    weeklyPct: null,
    resetAt: null,
    observedAt: 0,
    nextProbeAt: 0,
    latestReason: reason,
    activeAutonomousLeases: 0,
    lastAutonomousStartAt: null,
  };
}

export class AgentCapacityStore {
  private readonly records = new JsonMapStore<AgentCapacityRecord>(FILE);

  read(agent: AgentKind, now = Date.now()): AgentCapacityView {
    const raw = this.records.get(agent);
    if (raw === undefined) return fallback(agent, "capacity-state-absent");
    if (!isCapacityRecord(raw) || raw.observation.agent !== agent) {
      return fallback(agent, "capacity-state-invalid");
    }
    const observation =
      raw.observation.state === "exhausted" &&
      raw.observation.resetAt !== null &&
      raw.observation.resetAt <= now
        ? {
            ...raw.observation,
            state: "unknown" as const,
            resetAt: null,
            nextProbeAt: now,
            latestReason: "capacity-reset-passed",
          }
        : raw.observation;
    return {
      ...observation,
      activeAutonomousLeases: Object.values(raw.leases).filter((lease) => lease.expiresAt > now)
        .length,
      lastAutonomousStartAt: raw.lastAutonomousStartAt,
    };
  }

  recordObservation(observation: AgentCapacityObservation): void {
    const existing = this.validRecord(observation.agent);
    this.records.set(observation.agent, {
      schemaVersion: 1,
      observation,
      leases: existing?.leases ?? {},
      lastAutonomousStartAt: existing?.lastAutonomousStartAt ?? null,
    });
  }

  acquireLease(agent: AgentKind, leaseId: string, now: number, ttlMs = 24 * 60 * 60_000): boolean {
    const existing = this.validRecord(agent);
    if (existing === undefined) return false;
    const currentLease = existing.leases[leaseId];
    if (currentLease !== undefined) {
      this.records.set(agent, {
        ...existing,
        leases: {
          ...existing.leases,
          [leaseId]: {
            acquiredAt: currentLease.expiresAt > now ? currentLease.acquiredAt : now,
            expiresAt: now + ttlMs,
          },
        },
      });
      return true;
    }
    this.records.set(agent, {
      ...existing,
      leases: {
        ...Object.fromEntries(
          Object.entries(existing.leases).filter(([, lease]) => lease.expiresAt > now),
        ),
        [leaseId]: { acquiredAt: now, expiresAt: now + ttlMs },
      },
    });
    return true;
  }

  hasLease(agent: AgentKind, leaseId: string, now: number): boolean {
    const existing = this.validRecord(agent);
    return (
      existing?.leases[leaseId]?.expiresAt !== undefined && existing.leases[leaseId].expiresAt > now
    );
  }

  releaseLease(agent: AgentKind, leaseId: string): boolean {
    const existing = this.validRecord(agent);
    if (existing === undefined || !(leaseId in existing.leases)) return false;
    const leases = { ...existing.leases };
    delete leases[leaseId];
    this.records.set(agent, { ...existing, leases });
    return true;
  }

  recordAutonomousStart(agent: AgentKind, now: number): boolean {
    const existing = this.validRecord(agent);
    if (existing === undefined) return false;
    this.records.set(agent, { ...existing, lastAutonomousStartAt: now });
    return true;
  }

  ensureUnknown(agent: AgentKind, now: number): void {
    if (this.validRecord(agent) !== undefined) return;
    this.recordObservation({
      agent,
      authentication: "unknown",
      state: "unknown",
      fiveHourPct: null,
      weeklyPct: null,
      resetAt: null,
      observedAt: now,
      nextProbeAt: now,
      latestReason: "capacity-state-absent",
    });
  }

  private validRecord(agent: AgentKind): AgentCapacityRecord | undefined {
    const raw = this.records.get(agent);
    return isCapacityRecord(raw) && raw.observation.agent === agent ? raw : undefined;
  }
}
