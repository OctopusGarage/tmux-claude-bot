import { JsonMapStore } from "../infra/json-map-store.js";
import { nextFire } from "../scheduler/scheduling.js";
import type { LoopConfig, LoopProjectConfig } from "./config.js";

const FIRST_TICK_LOOKBACK_MS = 10 * 60_000;

export type LoopTickInput = {
  config: LoopConfig;
  now: number;
  lastFired: Record<string, number>;
  setLastFired: (projectId: string, firedAt: number) => void;
};

export type LoopDueProject = {
  projectId: string;
  name: string;
  scheduledAt: number;
  action: "would-run";
};

export type LoopSkippedProject = {
  projectId: string;
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

function scheduledFire(project: LoopProjectConfig, lastFired: number | undefined, now: number) {
  if (project.schedule === undefined) return { kind: "manual" as const };
  if (lastFired === undefined) {
    let after = now - FIRST_TICK_LOOKBACK_MS;
    let latest: number | null = null;
    for (;;) {
      const scheduledAt = nextFire({ kind: "cron", cron: project.schedule }, after);
      if (scheduledAt === null)
        return latest === null
          ? { kind: "invalid" as const }
          : { kind: "due" as const, scheduledAt: latest };
      if (scheduledAt > now) break;
      latest = scheduledAt;
      after = scheduledAt;
    }
    return latest === null
      ? { kind: "not-due" as const }
      : { kind: "due" as const, scheduledAt: latest };
  }
  const after = lastFired;
  const scheduledAt = nextFire({ kind: "cron", cron: project.schedule }, after);
  if (scheduledAt === null) return { kind: "invalid" as const };
  if (scheduledAt <= now) return { kind: "due" as const, scheduledAt };
  return { kind: "not-due" as const };
}

export function runLoopSchedulerTick(input: LoopTickInput): LoopTickSummary {
  const dueProjects: LoopDueProject[] = [];
  const skipped: LoopSkippedProject[] = [];
  let scheduled = 0;

  for (const project of input.config.projects) {
    const result = scheduledFire(project, input.lastFired[project.id], input.now);
    if (result.kind === "manual") {
      skipped.push({ projectId: project.id, reason: "manual-only" });
      continue;
    }
    scheduled++;
    if (result.kind === "invalid") {
      skipped.push({ projectId: project.id, reason: "invalid-schedule" });
      continue;
    }
    if (result.kind === "not-due") {
      skipped.push({ projectId: project.id, reason: "not-due" });
      continue;
    }
    dueProjects.push({
      projectId: project.id,
      name: project.name,
      scheduledAt: result.scheduledAt,
      action: "would-run",
    });
    input.setLastFired(project.id, result.scheduledAt);
  }

  return {
    phase: "due-only",
    checked: input.config.projects.length,
    scheduled,
    due: dueProjects.length,
    executed: 0,
    dueProjects,
    skipped,
  };
}
