import type { SchedulerStore } from "./scheduler-store.js";
import { hasActiveRun, materializeRun } from "./scheduling.js";

type Ok = { ok: true };
type Err = { ok: false; error: string };
type Result = Ok | Err;

export function startPlan(store: SchedulerStore, planId: string, now: number): Result {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, error: `unknown plan "${planId}"` };
  if (hasActiveRun(store.getActiveRun())) return { ok: false, error: "a run is already active" };
  store.setActiveRun(materializeRun(plan, `run-${now}`, now));
  return { ok: true };
}

export function pauseRun(store: SchedulerStore): Result {
  const run = store.getActiveRun();
  if (!run) return { ok: false, error: "no active run" };
  store.setActiveRun({ ...run, status: "paused" });
  return { ok: true };
}

export function resumeRun(store: SchedulerStore): Result {
  const run = store.getActiveRun();
  if (!run) return { ok: false, error: "no active run" };
  store.setActiveRun({ ...run, status: "running" });
  return { ok: true };
}

/** Stop the active batch run. Safe to call when no run is active. */
export function stopRun(store: SchedulerStore): void {
  const run = store.getActiveRun();
  if (!run) return;
  store.setActiveRun(null);
}
