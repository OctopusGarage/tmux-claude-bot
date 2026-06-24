import { AutopilotStore } from "../autopilot/state-store.js";
import type { SchedulerStore } from "./scheduler-store.js";
import { hasActiveRun, materializeRun } from "./scheduling.js";
import { TERMINAL_STATUSES } from "./types.js";

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

/** Stop the active batch run. Releases every non-terminal task's session:
 * disables autopilot and clears viaScheduler so those sessions are no longer
 * permanently skipped by global keep-alive after the stop. Safe to call when
 * no run is active. The optional autopilot param allows injection in tests. */
export function stopRun(
  store: SchedulerStore,
  autopilot: AutopilotStore = new AutopilotStore(),
): void {
  const run = store.getActiveRun();
  if (!run) return;
  // Bug #2 fix: release non-terminal sessions before nulling the run so they
  // aren't permanently excluded from global keep-alive (viaScheduler:true) and
  // aren't still being driven (enabled:true) after the batch is cancelled.
  for (const t of run.tasks) {
    if (t.sessionName !== undefined && !TERMINAL_STATUSES.has(t.status)) {
      autopilot.set(t.sessionName, {
        ...autopilot.get(t.sessionName),
        enabled: false,
        viaScheduler: false,
      });
    }
  }
  store.setActiveRun(null);
}
