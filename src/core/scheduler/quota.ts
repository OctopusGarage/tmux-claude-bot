import type { AgentKind } from "../agents/types.js";
import type { UsageSnapshot } from "../read/usage.js";
import type { PoolState, Run } from "./types.js";

/** Account-level quota hit: any rolling-window pct at/over the threshold. */
export function accountQuotaHit(snap: UsageSnapshot | null, pct: number): boolean {
  if (!snap) return false;
  return [snap.fiveHourPct, snap.sevenDayPct].some((p) => p !== null && p >= pct);
}

/** Earliest FUTURE reset (snapshot resets are epoch SECONDS) in ms, else a reprobe fallback. */
export function resumeAtFrom(snap: UsageSnapshot | null, now: number, reprobeMs: number): number {
  const candidates = [snap?.fiveHourReset, snap?.sevenDayReset]
    .filter((r): r is number => typeof r === "number")
    .map((r) => r * 1000)
    .filter((ms) => ms > now);
  return candidates.length > 0 ? Math.min(...candidates) : now + reprobeMs;
}

/**
 * Pause an agent pool on account quota: only RUNNING tasks → paused-quota (freeing
 * their slots, preserving their in-flight goal progress for a `resuming` resume).
 * Queued tasks are left queued — the pool's `paused` flag blocks their admission
 * (see `tasksToAdmit`), so on resume they are admitted FRESH rather than wrongly
 * marked `resuming` (a never-started task has no cycle to resume).
 */
export function pausePool(
  run: Run,
  pools: Record<string, PoolState>,
  agent: AgentKind,
  resumeAt: number,
): { run: Run; pools: Record<string, PoolState> } {
  const next: Run = {
    ...run,
    tasks: run.tasks.map((t) =>
      t.agent === agent && t.status === "running"
        ? { ...t, status: "paused-quota" as const, resuming: false }
        : t,
    ),
  };
  return { run: next, pools: { ...pools, [agent]: { paused: true, resumeAt } } };
}

/** Resume a paused pool once now ≥ resumeAt: paused-quota tasks → queued (resuming:true). */
export function resumePool(
  run: Run,
  pools: Record<string, PoolState>,
  agent: AgentKind,
  now: number,
): { run: Run; pools: Record<string, PoolState> } {
  const ps = pools[agent];
  if (!ps?.paused || ps.resumeAt === undefined || now < ps.resumeAt) return { run, pools };
  const next: Run = {
    ...run,
    tasks: run.tasks.map((t) =>
      t.agent === agent && t.status === "paused-quota"
        ? { ...t, status: "queued" as const, resuming: true }
        : t,
    ),
  };
  return { run: next, pools: { ...pools, [agent]: { paused: false } } };
}
