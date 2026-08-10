// src/core/scheduler/scheduler.ts

import { createLogger } from "../../shared/utils/logger.js";
import type { AgentKind } from "../agents/types.js";
import { tasksToAdmit } from "./admission.js";
import type { PoolState, Run, TaskState } from "./types.js";

const log = createLogger("scheduler.core");

export type ReconcileDeps = {
  resolveSession: (task: TaskState) => string;
  /** A session-level admission gate. Queued tasks remain queued while gated. */
  isGated?: (session: string) => boolean;
  now: number;
};

/** Admit up to the per-agent caps and flip admitted tasks to running.
 * Returns a NEW run (immutable update). */
export function reconcile(
  run: Run,
  caps: Partial<Record<AgentKind, number>>,
  pools: Record<string, PoolState>,
  deps: ReconcileDeps,
): Run {
  const sessions = new Map<TaskState, string>();
  const admit = tasksToAdmit(run.tasks, caps, pools, (task) => {
    const session = deps.resolveSession(task);
    sessions.set(task, session);
    return !deps.isGated?.(session);
  });
  if (admit.length === 0) return run;
  const admitted = new Set(admit);
  const tasks = run.tasks.map((t) => {
    if (!admitted.has(t)) return t;
    const session = sessions.get(t) ?? deps.resolveSession(t);
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
