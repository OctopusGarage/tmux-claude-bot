import type { LoopConfig } from "./config.js";

export type LoopJitterJobKind =
  | "architecture"
  | "workspace-architecture"
  | "bug-fix"
  | "test-coverage"
  | "security-maintenance"
  | "harness-auto"
  | "opportunity-discovery"
  | "pull-request-review"
  | "repository-pull-request-review";

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
  return (
    stableHash(`${jitter.seed}:${input.jobKey}:${input.jobKind}:${input.scheduledAt}`) % (maxMs + 1)
  );
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
  if (jobKind === "bug-fix") return jitter.bugFixMaxDelayMinutes;
  if (jobKind === "pull-request-review") return jitter.pullRequestReviewMaxDelayMinutes;
  return jitter.repositoryPullRequestReviewMaxDelayMinutes;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let idx = 0; idx < value.length; idx++) {
    hash ^= value.charCodeAt(idx);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
