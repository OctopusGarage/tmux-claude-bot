import { JsonMapStore } from "../infra/json-map-store.js";
import { nextFire } from "../scheduler/scheduling.js";
import type {
  LoopConfig,
  LoopProjectConfig,
  LoopRepositoryPullRequestReviewConfig,
  LoopWorkspaceConfig,
} from "./config.js";
import {
  type LoopJitterJobKind,
  loopScheduleJitterMaxMs,
  loopScheduleJitterMs,
} from "./schedule-jitter.js";

const FIRST_TICK_LOOKBACK_MS = 10 * 60_000;

export type LoopTickInput = {
  config: LoopConfig;
  now: number;
  lastFired: Record<string, number>;
};

export type LoopDueProject = {
  projectId: string;
  name: string;
  jobKey: string;
  jobKind: LoopJitterJobKind;
  scheduledAt: number;
  effectiveAt: number;
  jitterMs: number;
  action: "would-run";
};

export type LoopSkippedProject = {
  projectId: string;
  jobKey: string;
  jobKind: LoopDueProject["jobKind"];
  scheduledAt?: number;
  effectiveAt?: number;
  jitterMs?: number;
  reason: "manual-only" | "not-due" | "invalid-schedule";
};

export type LoopTickSummary = {
  phase: "due-only";
  checked: number;
  scheduled: number;
  due: number;
  executed: 0;
  dueProjects: LoopDueProject[];
  skipped: LoopSkippedProject[];
};

export class LoopSchedulerStore {
  private readonly fired = new JsonMapStore<number>("loop_lastfired.json");

  getLastFired(): Record<string, number> {
    return Object.fromEntries(this.fired.sortedEntries());
  }

  setLastFired(projectId: string, firedAt: number): void {
    this.fired.set(projectId, firedAt);
  }

  clearLastFired(projectId: string): void {
    this.fired.delete(projectId);
  }
}

function scheduledFire(
  job: ScheduledJob,
  config: LoopConfig,
  lastFired: number | undefined,
  now: number,
) {
  const schedule = job.schedule;
  if (schedule === undefined) return { kind: "manual" as const };
  const dueState = (scheduledAt: number) => {
    const jitterMs = scheduleJitterMs(job, config, scheduledAt);
    const effectiveAt = scheduledAt + jitterMs;
    return effectiveAt > now
      ? { kind: "not-due" as const, scheduledAt, effectiveAt, jitterMs }
      : { kind: "due" as const, scheduledAt, effectiveAt, jitterMs };
  };
  if (lastFired === undefined) {
    let after = now - FIRST_TICK_LOOKBACK_MS - scheduleJitterMaxMs(job, config);
    let latest: number | null = null;
    for (;;) {
      const scheduledAt = nextFire({ kind: "cron", cron: schedule }, after);
      if (scheduledAt === null)
        return latest === null ? { kind: "invalid" as const } : dueState(latest);
      if (scheduledAt > now) break;
      latest = scheduledAt;
      after = scheduledAt;
    }
    return latest === null ? { kind: "not-due" as const } : dueState(latest);
  }
  let after = lastFired;
  let latest: number | null = null;
  for (;;) {
    const scheduledAt = nextFire({ kind: "cron", cron: schedule }, after);
    if (scheduledAt === null)
      return latest === null ? { kind: "invalid" as const } : dueState(latest);
    if (scheduledAt > now) break;
    latest = scheduledAt;
    after = scheduledAt;
  }
  return latest === null ? { kind: "not-due" as const } : dueState(latest);
}

export function runLoopSchedulerTick(input: LoopTickInput): LoopTickSummary {
  const dueProjects: LoopDueProject[] = [];
  const skipped: LoopSkippedProject[] = [];
  let scheduled = 0;
  const jobs = scheduledJobs(input.config);

  for (const job of jobs) {
    const result = scheduledFire(job, input.config, input.lastFired[job.jobKey], input.now);
    if (result.kind === "manual") {
      skipped.push({
        projectId: job.project.id,
        jobKey: job.jobKey,
        jobKind: job.jobKind,
        reason: "manual-only",
      });
      continue;
    }
    scheduled++;
    if (result.kind === "invalid") {
      skipped.push({
        projectId: job.project.id,
        jobKey: job.jobKey,
        jobKind: job.jobKind,
        reason: "invalid-schedule",
      });
      continue;
    }
    if (result.kind === "not-due") {
      skipped.push({
        projectId: job.project.id,
        jobKey: job.jobKey,
        jobKind: job.jobKind,
        reason: "not-due",
        ...("scheduledAt" in result
          ? {
              scheduledAt: result.scheduledAt,
              effectiveAt: result.effectiveAt,
              jitterMs: result.jitterMs,
            }
          : {}),
      });
      continue;
    }
    dueProjects.push({
      projectId: job.project.id,
      name: job.project.name,
      jobKey: job.jobKey,
      jobKind: job.jobKind,
      scheduledAt: result.scheduledAt,
      effectiveAt: result.effectiveAt,
      jitterMs: result.jitterMs,
      action: "would-run",
    });
  }

  return {
    phase: "due-only",
    checked: jobs.length,
    scheduled,
    due: dueProjects.length,
    executed: 0,
    dueProjects,
    skipped,
  };
}

type ScheduledJob = {
  project: LoopProjectConfig | LoopRepositoryPullRequestReviewConfig | LoopWorkspaceConfig;
  jobKey: string;
  jobKind: LoopJitterJobKind;
  schedule: string | undefined;
  scheduleJitterMinutes?: number;
};

function scheduledJobs(config: LoopConfig): ScheduledJob[] {
  return [
    ...config.projects.flatMap((project) => [
      {
        project,
        jobKey: project.id,
        jobKind: "architecture" as const,
        schedule: project.schedule,
        ...(project.scheduleJitterMinutes !== undefined
          ? { scheduleJitterMinutes: project.scheduleJitterMinutes }
          : {}),
      },
      ...(project.bugFix.enabled
        ? [
            {
              project,
              jobKey: `${project.id}:bug-fix`,
              jobKind: "bug-fix" as const,
              schedule: project.bugFix.schedule,
              ...(project.bugFix.scheduleJitterMinutes !== undefined
                ? { scheduleJitterMinutes: project.bugFix.scheduleJitterMinutes }
                : {}),
            },
          ]
        : []),
      ...(project.testCoverage.enabled
        ? [
            {
              project,
              jobKey: `${project.id}:test-coverage`,
              jobKind: "test-coverage" as const,
              schedule: project.testCoverage.schedule,
              ...(project.testCoverage.scheduleJitterMinutes !== undefined
                ? { scheduleJitterMinutes: project.testCoverage.scheduleJitterMinutes }
                : {}),
            },
          ]
        : []),
      ...(project.securityMaintenance.enabled
        ? [
            {
              project,
              jobKey: `${project.id}:security-maintenance`,
              jobKind: "security-maintenance" as const,
              schedule: project.securityMaintenance.schedule,
              ...(project.securityMaintenance.scheduleJitterMinutes !== undefined
                ? { scheduleJitterMinutes: project.securityMaintenance.scheduleJitterMinutes }
                : {}),
            },
          ]
        : []),
      ...(project.pullRequestReview.enabled
        ? [
            {
              project,
              jobKey: `${project.id}:pull-request-review`,
              jobKind: "pull-request-review" as const,
              schedule: project.pullRequestReview.schedule,
              ...(project.pullRequestReview.scheduleJitterMinutes !== undefined
                ? { scheduleJitterMinutes: project.pullRequestReview.scheduleJitterMinutes }
                : {}),
            },
          ]
        : []),
    ]),
    ...config.prReview.repositories.map((repository) => ({
      project: repository,
      jobKey: `pr-review:${repository.id}`,
      jobKind: "repository-pull-request-review" as const,
      schedule: repository.schedule,
      ...(repository.scheduleJitterMinutes !== undefined
        ? { scheduleJitterMinutes: repository.scheduleJitterMinutes }
        : {}),
    })),
    ...config.workspaces.map((workspace) => ({
      project: workspace,
      jobKey: `workspace:${workspace.id}:architecture`,
      jobKind: "workspace-architecture" as const,
      schedule: workspace.architecture.enabled ? workspace.architecture.schedule : undefined,
      ...(workspace.architecture.scheduleJitterMinutes !== undefined
        ? { scheduleJitterMinutes: workspace.architecture.scheduleJitterMinutes }
        : {}),
    })),
  ];
}

function scheduleJitterMs(job: ScheduledJob, config: LoopConfig, scheduledAt: number): number {
  return loopScheduleJitterMs({
    config,
    jobKey: job.jobKey,
    jobKind: job.jobKind,
    scheduledAt,
    ...(job.scheduleJitterMinutes !== undefined
      ? { scheduleJitterMinutes: job.scheduleJitterMinutes }
      : {}),
  });
}

function scheduleJitterMaxMs(job: ScheduledJob, config: LoopConfig): number {
  return loopScheduleJitterMaxMs({
    config,
    jobKind: job.jobKind,
    ...(job.scheduleJitterMinutes !== undefined
      ? { scheduleJitterMinutes: job.scheduleJitterMinutes }
      : {}),
  });
}
