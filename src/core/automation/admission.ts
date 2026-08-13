import type { HostPowerConfig } from "../../shared/types.js";
import { admitQuietHoursWork } from "../platform/power-policy.js";
import { admitResourceWork } from "../resource-guardian/admission.js";
import type { ResourceAdmission, ResourceAdmissionInput } from "../resource-guardian/types.js";

const UNMANAGED_HOST_POWER: HostPowerConfig = {
  mode: "off",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};

export type AutomationAdmissionOptions = {
  hostPower?: HostPowerConfig;
  resourceAdmission?: (input: ResourceAdmissionInput) => ResourceAdmission;
};

/**
 * One pre-reservation gate for autonomous work. Quiet hours decide first so a
 * deferral cannot touch the Resource Guardian store or any producer queue.
 */
export function admitAutomationWork(
  input: ResourceAdmissionInput,
  options: AutomationAdmissionOptions = {},
): ResourceAdmission {
  const quietHours = admitQuietHoursWork(options.hostPower ?? UNMANAGED_HOST_POWER, {
    trigger: input.trigger,
    now: input.now,
  });
  if (!quietHours.allowed) {
    return { allowed: false, reason: quietHours.reason, incidentId: null };
  }
  return (options.resourceAdmission ?? admitResourceWork)(input);
}
