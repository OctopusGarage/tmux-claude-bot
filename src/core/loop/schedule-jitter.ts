import { AutomationOccurrenceStore } from "../automation/occurrence-window.js";
import type { LoopConfig } from "./config.js";
import type { LoopTaskSchedulerJobKind } from "./task-family.js";

export type LoopJitterJobKind = LoopTaskSchedulerJobKind;

export function loopScheduleJitterMs(input: {
  config: LoopConfig;
  jobKey: string;
  jobKind: LoopJitterJobKind;
  scheduledAt: number;
  scheduleJitterMinutes?: number;
}): number {
  const jitter = input.config.scheduler.jitter;
  if (!jitter.enabled) return 0;
  const maxMs = loopScheduleJitterMaxMs(input);
  if (maxMs <= 0) return 0;
  const occurrence = new AutomationOccurrenceStore().plan({
    key: `${input.jobKey}:${input.jobKind}`,
    scheduledAt: input.scheduledAt,
    windowMs: maxMs,
    now: input.scheduledAt,
    source: "loop-engineering",
  });
  return occurrence.notBefore - input.scheduledAt;
}

export function loopScheduleJitterMaxMs(input: {
  config: LoopConfig;
  jobKind: LoopJitterJobKind;
  scheduleJitterMinutes?: number;
}): number {
  const jitter = input.config.scheduler.jitter;
  if (!jitter.enabled) return 0;
  const configuredMinutes =
    input.scheduleJitterMinutes ?? defaultJitterMinutes(input.jobKind, input.config);
  return Math.max(0, configuredMinutes) * 60_000;
}

function defaultJitterMinutes(jobKind: LoopJitterJobKind, config: LoopConfig): number {
  const jitter = config.scheduler.jitter;
  if (jobKind === "architecture" || jobKind === "workspace-architecture")
    return jitter.architectureMaxDelayMinutes;
  if (jobKind === "test-coverage") return jitter.testCoverageMaxDelayMinutes;
  if (jobKind === "security-maintenance") return jitter.securityMaintenanceMaxDelayMinutes;
  if (jobKind === "harness-auto") return jitter.harnessAutoMaxDelayMinutes;
  if (jobKind === "opportunity-discovery") return jitter.opportunityDiscoveryMaxDelayMinutes;
  if (jobKind === "automation-governance-review")
    return jitter.automationGovernanceReviewMaxDelayMinutes;
  if (jobKind === "bug-fix") return jitter.bugFixMaxDelayMinutes;
  if (jobKind === "pull-request-review") return jitter.pullRequestReviewMaxDelayMinutes;
  return jitter.repositoryPullRequestReviewMaxDelayMinutes;
}
