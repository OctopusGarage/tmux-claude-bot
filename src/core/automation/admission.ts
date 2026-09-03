import type { HostPowerConfig } from "../../shared/types.js";
import { admitQuietHoursWork } from "../platform/power-policy.js";
import { admitResourceWork } from "../resource-guardian/admission.js";
import type { ResourceAdmission, ResourceAdmissionInput } from "../resource-guardian/types.js";
import { type AgentCapacityView, decideCapacityAdmission } from "./capacity.js";
import type { AutomationOccurrence } from "./occurrence-window.js";

const UNMANAGED_HOST_POWER: HostPowerConfig = {
  mode: "off",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};

export type AutomationAdmissionOptions = {
  hostPower?: HostPowerConfig;
  resourceAdmission?: (input: ResourceAdmissionInput) => ResourceAdmission;
  occurrence?: AutomationOccurrence;
  ownerLastActivityAt?: number | null;
  interactiveBusy?: boolean;
  capacity?: AgentCapacityView;
  repairDepth?: number;
};

export type AutomationAdmission =
  | { allowed: true; reason: string; incidentId: string | null }
  | { allowed: false; reason: string; incidentId: string | null; retryAt?: number };

const REQUIRED_IDLE_MS = 15 * 60_000;
const AUTONOMOUS_HEAVY_RETRY_MS = 15 * 60_000;

function shouldSerializeAutonomousHeavyWork(input: ResourceAdmissionInput): boolean {
  return (
    input.weight === "heavy" &&
    (input.trigger === "background" || input.trigger === "resource-repair")
  );
}

/**
 * One pre-reservation gate for autonomous work. Quiet hours decide first so a
 * deferral cannot touch the Resource Guardian store or any producer queue.
 */
export function admitAutomationWork(
  input: ResourceAdmissionInput,
  options: AutomationAdmissionOptions = {},
): AutomationAdmission {
  const occurrence = options.occurrence;
  if (occurrence?.status === "superseded" || occurrence?.status === "settled") {
    return { allowed: false, reason: `occurrence-${occurrence.status}`, incidentId: null };
  }
  if (occurrence !== undefined && input.now < occurrence.notBefore) {
    return {
      allowed: false,
      reason: "occurrence-not-before",
      incidentId: null,
      retryAt: occurrence.notBefore,
    };
  }
  if (input.trigger !== "interactive" && input.trigger !== "operator") {
    if (options.interactiveBusy === true) {
      return {
        allowed: false,
        reason: "interactive-agent-busy",
        incidentId: null,
        retryAt: input.now + REQUIRED_IDLE_MS,
      };
    }
    const ownerLastActivityAt = options.ownerLastActivityAt ?? null;
    if (ownerLastActivityAt !== null && input.now - ownerLastActivityAt < REQUIRED_IDLE_MS) {
      return {
        allowed: false,
        reason: "recent-owner-activity",
        incidentId: null,
        retryAt:
          ownerLastActivityAt > input.now
            ? input.now + REQUIRED_IDLE_MS
            : ownerLastActivityAt + REQUIRED_IDLE_MS,
      };
    }
  }
  const quietHours = admitQuietHoursWork(options.hostPower ?? UNMANAGED_HOST_POWER, {
    trigger: input.trigger,
    now: input.now,
  });
  if (!quietHours.allowed) {
    return {
      allowed: false,
      reason: quietHours.reason,
      incidentId: null,
      retryAt: quietHours.retryAt,
    };
  }
  if (options.capacity !== undefined) {
    const capacity = decideCapacityAdmission({
      now: input.now,
      state: options.capacity.state,
      resetAt: options.capacity.resetAt,
      trigger: input.trigger,
      activeLeases: options.capacity.activeAutonomousLeases,
      lastAutonomousStartAt: options.capacity.lastAutonomousStartAt,
      repairDepth: options.repairDepth ?? 0,
    });
    if (!capacity.allowed) {
      return {
        allowed: false,
        reason: capacity.reason,
        incidentId: null,
        ...(capacity.retryAt === undefined ? {} : { retryAt: capacity.retryAt }),
      };
    }
    if (shouldSerializeAutonomousHeavyWork(input) && options.capacity.activeAutonomousLeases > 0) {
      return {
        allowed: false,
        reason: "autonomous-heavy-active-lease",
        incidentId: null,
        retryAt: input.now + AUTONOMOUS_HEAVY_RETRY_MS,
      };
    }
  }
  return (options.resourceAdmission ?? admitResourceWork)(input);
}
