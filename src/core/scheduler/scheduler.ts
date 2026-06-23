// src/core/scheduler/scheduler.ts

import { createLogger } from "../../shared/utils/logger.js";
import type { AgentKind } from "../agents/types.js";
import { startCycleState } from "../autopilot/goals/goal-state.js";
import type { AutopilotState } from "../autopilot/types.js";
import { tasksToAdmit } from "./admission.js";
import type { PoolState, Run, TaskState } from "./types.js";

const log = createLogger("scheduler.core");

export type ReconcileDeps = {
  autopilot: {
    get(session: string): AutopilotState;
    set(session: string, st: AutopilotState): void;
  };
  resolveSession: (task: TaskState) => string;
  now: number;
};

/** Admit up to the per-agent caps: seed each admitted session's autopilot
 * (enabled + goal-cycle + viaScheduler) and flip its task to running. Returns a
 * NEW run (immutable update); side effects only through `deps.autopilot`. */
export function reconcile(
  run: Run,
  caps: Partial<Record<AgentKind, number>>,
  pools: Record<string, PoolState>,
  deps: ReconcileDeps,
): Run {
  const admit = tasksToAdmit(run.tasks, caps, pools);
  if (admit.length === 0) return run;
  const admitted = new Set(admit);
  const tasks = run.tasks.map((t) => {
    if (!admitted.has(t)) return t;
    const session = deps.resolveSession(t);
    const prev = deps.autopilot.get(session);
    // fresh admission seeds the goal-cycle; resume (Phase 2) re-enables without reset.
    const next: AutopilotState = t.resuming
      ? { ...prev, enabled: true, viaScheduler: true }
      : { ...startCycleState(prev, t.goals, t.rounds), enabled: true, viaScheduler: true };
    deps.autopilot.set(session, next);
    log.info("scheduler admitted task", {
      session,
      data: { project: t.project, agent: t.agent, resuming: t.resuming ?? false },
    });
    return { ...t, status: "running" as const, sessionName: session, startedAt: deps.now };
  });
  return { ...run, tasks };
}

/** Terminal handling for a non-quota stop: re-queue if retries remain, else fail. */
export function failOrRetry(t: TaskState, reason: string): TaskState {
  if (t.attempt < t.retries) {
    return {
      project: t.project,
      agent: t.agent,
      goals: t.goals,
      rounds: t.rounds,
      retries: t.retries,
      priority: t.priority,
      status: "queued" as const,
      attempt: t.attempt + 1,
      goalsCompleted: t.goalsCompleted,
      resuming: false,
    };
  }
  return { ...t, status: "failed", error: reason, endedAt: Date.now() };
}

/** PURE transition for an autopilot notice. Phase 1 handles only completion;
 * quota / human-gate / failure transitions land in Phase 2. */
export function applyNotice(run: Run, notice: { kind: string; session: string }): Run {
  const idx = run.tasks.findIndex(
    (t) => t.sessionName === notice.session && t.status === "running",
  );
  if (idx < 0) return run;
  const t = run.tasks[idx];
  if (t === undefined) return run;
  let next: TaskState | undefined;
  if (notice.kind === "complete" || notice.kind === "cycleComplete") {
    next = { ...t, status: "done", endedAt: Date.now() };
  } else if (notice.kind === "awaitHuman") {
    next = { ...t, status: "awaiting-human" };
  } else if (notice.kind === "maxIter" || notice.kind === "wallClock") {
    next = failOrRetry(t, notice.kind);
  }
  if (next === undefined) return run; // usage / stopped / paused handled elsewhere
  const tasks = run.tasks.slice();
  tasks[idx] = next;
  return { ...run, tasks };
}
