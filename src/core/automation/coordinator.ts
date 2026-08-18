import type { HostPowerConfig } from "../../shared/types.js";
import type { AgentKind } from "../agents/types.js";
import type { ResourceAdmission, ResourceAdmissionInput } from "../resource-guardian/types.js";
import { type AutomationAdmission, admitAutomationWork } from "./admission.js";
import { appendAutomationAdmissionEvent } from "./admission-events.js";
import type { AgentCapacityObservation, AgentCapacityState } from "./capacity.js";
import { AgentCapacityStore } from "./capacity-store.js";
import { AutomationOccurrenceStore } from "./occurrence-window.js";

export type AutonomousWorkIntent = Omit<ResourceAdmissionInput, "now"> & {
  id: string;
  agent: AgentKind;
  occurrenceId?: string;
  repairDepth?: number;
};

export type AutonomousAdmissionContext = {
  hostPower?: HostPowerConfig;
  ownerLastActivityAt?: number | null;
  interactiveBusy?: boolean;
  resourceAdmission?: (input: ResourceAdmissionInput) => ResourceAdmission;
};

type CoordinatorOptions = {
  capacity?: AgentCapacityStore;
  occurrences?: AutomationOccurrenceStore;
  now?: () => number;
  onCapacityTransition?: (transition: AgentCapacityTransition) => unknown;
};

export type AgentCapacityTransition = {
  agent: AgentKind;
  from: AgentCapacityState;
  to: AgentCapacityState;
  reason: string;
  resetAt: number | null;
};

export type AutonomousExecutionResult<T> =
  | { executed: true; value: T }
  | { executed: false; admission: Extract<AutomationAdmission, { allowed: false }> };

export type AutonomousAdmissionLease = {
  leaseId: string;
  intent: AutonomousWorkIntent;
};

export type AutonomousFinalAdmission =
  | { allowed: true; reason: string; incidentId: string | null; lease: AutonomousAdmissionLease }
  | Extract<AutomationAdmission, { allowed: false }>;

const OFFICIAL_LIMIT_LINE =
  /^\s*(?:you(?:'ve| have) hit your (?:usage|rate|quota) limit|(?:usage|rate|quota) limit (?:reached|exceeded)|(?:usage|quota) (?:exhausted|unavailable))(?:\s|[.;:·-]|$)/i;
const ISO_RESET =
  /\bresets?\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))\b/i;
const CLOCK_RESET = /\bresets?\s+(\d{1,2}):(\d{2})\b/i;

export function autonomousCapacityLeaseId(
  intent: Pick<AutonomousWorkIntent, "source" | "id">,
): string {
  return `autonomous:${intent.source}:${intent.id}`;
}

function officialLimitResetAt(text: string, now: number): number | null | undefined {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => OFFICIAL_LIMIT_LINE.test(candidate));
  if (line === undefined) return undefined;
  const iso = ISO_RESET.exec(line)?.[1];
  if (iso !== undefined) {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) && parsed > now ? parsed : null;
  }
  const clock = CLOCK_RESET.exec(line);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour <= 23 && minute <= 59) {
      const reset = new Date(now);
      reset.setHours(hour, minute, 0, 0);
      if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
      return reset.getTime();
    }
  }
  return null;
}

/**
 * Durable two-stage authority for autonomous work. Producers may precheck before
 * reservation; execute always revalidates and acquires the capacity lease again.
 */
export class AutonomousWorkCoordinator {
  private readonly capacity: AgentCapacityStore;
  private readonly occurrences: AutomationOccurrenceStore;
  private readonly now: () => number;
  private readonly onCapacityTransition?: CoordinatorOptions["onCapacityTransition"];

  constructor(options: CoordinatorOptions = {}) {
    this.capacity = options.capacity ?? new AgentCapacityStore();
    this.occurrences = options.occurrences ?? new AutomationOccurrenceStore();
    this.now = options.now ?? Date.now;
    this.onCapacityTransition = options.onCapacityTransition;
  }

  precheck(intent: AutonomousWorkIntent, context: AutonomousAdmissionContext): AutomationAdmission {
    return this.decide(intent, context, 0);
  }

  revalidate(
    lease: AutonomousAdmissionLease,
    context: AutonomousAdmissionContext,
  ): AutomationAdmission {
    return this.decide(lease.intent, context, 1);
  }

  private decide(
    intent: AutonomousWorkIntent,
    context: AutonomousAdmissionContext,
    ownedLeaseCount: number,
  ): AutomationAdmission {
    const now = this.now();
    this.capacity.ensureUnknown(intent.agent, now);
    const occurrence =
      intent.occurrenceId === undefined ? undefined : this.occurrences.get(intent.occurrenceId);
    const capacity = this.capacity.read(intent.agent, now);
    const admission = admitAutomationWork(
      {
        source: intent.source,
        trigger: intent.trigger,
        weight: intent.weight,
        now,
        ...(intent.forced === undefined ? {} : { forced: intent.forced }),
      },
      {
        ...(context.hostPower === undefined ? {} : { hostPower: context.hostPower }),
        ...(context.ownerLastActivityAt === undefined
          ? {}
          : { ownerLastActivityAt: context.ownerLastActivityAt }),
        ...(context.interactiveBusy === undefined
          ? {}
          : { interactiveBusy: context.interactiveBusy }),
        ...(context.resourceAdmission === undefined
          ? {}
          : { resourceAdmission: context.resourceAdmission }),
        capacity: {
          ...capacity,
          activeAutonomousLeases: Math.max(0, capacity.activeAutonomousLeases - ownedLeaseCount),
          lastAutonomousStartAt: ownedLeaseCount > 0 ? null : capacity.lastAutonomousStartAt,
        },
        ...(intent.repairDepth === undefined ? {} : { repairDepth: intent.repairDepth }),
        ...(occurrence === undefined ? {} : { occurrence }),
      },
    );
    if (!admission.allowed)
      this.recordDecision(intent, "deferred", admission.reason, admission.retryAt);
    return admission;
  }

  admit(
    intent: AutonomousWorkIntent,
    context: AutonomousAdmissionContext,
  ): AutonomousFinalAdmission {
    const now = this.now();
    const leaseId = autonomousCapacityLeaseId(intent);
    const admission = this.decide(
      intent,
      context,
      this.capacity.hasLease(intent.agent, leaseId, now) ? 1 : 0,
    );
    if (!admission.allowed) return admission;
    if (!this.capacity.acquireLease(intent.agent, leaseId, now)) {
      const denied = {
        allowed: false as const,
        reason: "capacity-state-unavailable",
        incidentId: null,
      };
      this.recordDecision(intent, "deferred", denied.reason);
      return denied;
    }
    this.capacity.recordAutonomousStart(intent.agent, now);
    if (intent.occurrenceId !== undefined) {
      this.occurrences.setStatus(intent.occurrenceId, "admitted", now);
    }
    this.recordDecision(intent, "admitted", admission.reason);
    return { ...admission, lease: { leaseId, intent } };
  }

  settle(lease: AutonomousAdmissionLease, options: { settleOccurrence?: boolean } = {}): void {
    const settledAt = this.now();
    this.capacity.releaseLease(lease.intent.agent, lease.leaseId);
    if (lease.intent.occurrenceId !== undefined && (options.settleOccurrence ?? true)) {
      this.occurrences.setStatus(lease.intent.occurrenceId, "settled", settledAt);
    }
    this.recordDecision(lease.intent, "settled", "execution-settled");
  }

  async execute<T>(
    intent: AutonomousWorkIntent,
    context: AutonomousAdmissionContext,
    operation: (lease: AutonomousAdmissionLease) => Promise<T>,
    options: { settleOccurrence?: (value: T) => boolean } = {},
  ): Promise<AutonomousExecutionResult<T>> {
    const admission = this.admit(intent, context);
    if (!admission.allowed) return { executed: false, admission };
    let value: T | undefined;
    let completed = false;
    try {
      value = await operation(admission.lease);
      completed = true;
      return { executed: true, value };
    } finally {
      this.settle(admission.lease, {
        settleOccurrence: completed && (options.settleOccurrence?.(value as T) ?? true),
      });
    }
  }

  recordLimitSignal(
    agent: AgentKind,
    text: string,
    source: ResourceAdmissionInput["source"] = "loop-engineering",
  ): boolean {
    const now = this.now();
    const resetAt = officialLimitResetAt(text, now);
    if (resetAt === undefined) return false;
    const current = this.capacity.read(agent, now);
    this.recordCapacityObservation(
      {
        agent,
        authentication: current.authentication,
        state: "exhausted",
        fiveHourPct: current.fiveHourPct,
        weeklyPct: current.weeklyPct,
        resetAt,
        observedAt: now,
        nextProbeAt: resetAt ?? now + 15 * 60_000,
        latestReason: "official-limit-signal",
      },
      source,
    );
    return true;
  }

  recordCapacityObservation(
    observation: AgentCapacityObservation,
    source: ResourceAdmissionInput["source"],
  ): void {
    const previous = this.capacity.read(observation.agent, observation.observedAt);
    this.capacity.recordObservation(observation);
    if (previous.observedAt === 0 || previous.state === observation.state) return;
    const transition: AgentCapacityTransition = {
      agent: observation.agent,
      from: previous.state,
      to: observation.state,
      reason: observation.latestReason,
      resetAt: observation.resetAt,
    };
    appendAutomationAdmissionEvent({
      at: observation.observedAt,
      kind: "capacity-transition",
      source,
      intentId: `capacity:${observation.agent}:${previous.state}:${observation.state}`,
      agent: observation.agent,
      reason: `${previous.state}->${observation.state}:${observation.latestReason}`,
      ...(observation.resetAt === null ? {} : { retryAt: observation.resetAt }),
    });
    if (this.onCapacityTransition !== undefined) {
      try {
        void Promise.resolve(this.onCapacityTransition(transition)).catch(() => undefined);
      } catch {
        // Notification delivery cannot become admission authority.
      }
    }
  }

  settleOccurrence(occurrenceId: string): boolean {
    return this.occurrences.setStatus(occurrenceId, "settled", this.now());
  }

  private recordDecision(
    intent: AutonomousWorkIntent,
    kind: "deferred" | "admitted" | "settled",
    reason: string,
    retryAt?: number,
  ): void {
    appendAutomationAdmissionEvent({
      at: this.now(),
      kind,
      source: intent.source,
      intentId: intent.id,
      agent: intent.agent,
      ...(intent.occurrenceId === undefined ? {} : { occurrenceId: intent.occurrenceId }),
      reason,
      ...(retryAt === undefined ? {} : { retryAt }),
    });
  }
}
