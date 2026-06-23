// src/core/scheduler/scheduling.ts
import type { Plan, Run, Schedule, TaskState } from "./types.js";

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    const lo = m[1] === "*" ? min : Number(m[1]);
    let hi = m[2] !== undefined ? Number(m[2]) : m[1] === "*" ? max : lo;
    if (m[3] && m[2] === undefined) hi = max;
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi || step < 1)
      return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Next epoch-ms a 5-field cron matches, strictly after `after`. null if unparseable. */
export function nextCronFire(expr: string, after: number): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = [
    parseField(parts[0] as string, 0, 59),
    parseField(parts[1] as string, 0, 23),
    parseField(parts[2] as string, 1, 31),
    parseField(parts[3] as string, 1, 12),
    parseField(parts[4] as string, 0, 6),
  ];
  if (sets.some((s) => s === null)) return null;
  const [mins, hours, doms, months, dows] = sets as unknown as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const start = new Date(Math.ceil((after + 1) / 60000) * 60000); // next whole minute after `after`
  const limit = after + 366 * 24 * 60 * 60 * 1000;
  for (let t = start.getTime(); t <= limit; t += 60000) {
    const d = new Date(t);
    if (
      mins.has(d.getUTCMinutes()) &&
      hours.has(d.getUTCHours()) &&
      months.has(d.getUTCMonth() + 1) &&
      doms.has(d.getUTCDate()) &&
      dows.has(d.getUTCDay())
    )
      return t;
  }
  return null;
}

export function nextFire(schedule: Schedule, after: number): number | null {
  if (schedule.kind === "now") return after;
  if (schedule.kind === "at") return schedule.at > after ? schedule.at : null;
  return nextCronFire(schedule.cron, after);
}

export function materializeRun(plan: Plan, runId: string, now: number): Run {
  const tasks: TaskState[] = plan.projects.map((p) => ({
    project: p.path,
    agent: p.agent,
    goals: p.goals,
    rounds: p.rounds ?? plan.defaults?.rounds ?? 1,
    retries: p.retries ?? plan.defaults?.retries ?? 0,
    priority: p.priority ?? 0,
    status: "queued",
    attempt: 0,
    goalsCompleted: [],
  }));
  return { runId, planId: plan.id, startedAt: now, status: "running", tasks };
}

export function hasActiveRun(run: Run | undefined): boolean {
  return run?.status === "running" || run?.status === "paused";
}
