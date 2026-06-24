import type { AgentKind } from "../agents/types.js";
import type { PoolState, TaskState } from "./types.js";

/**
 * PURE: which queued tasks to admit right now. Highest-priority first; never
 * exceeds `caps[agent]` counting already-running tasks of that agent; skips a
 * paused pool and any agent with no configured cap. No I/O.
 */
export function tasksToAdmit(
  tasks: TaskState[],
  caps: Partial<Record<AgentKind, number>>,
  pools: Record<string, PoolState>,
): TaskState[] {
  const projected = new Map<AgentKind, number>();
  for (const t of tasks) {
    if (t.status === "running") projected.set(t.agent, (projected.get(t.agent) ?? 0) + 1);
  }
  const admit: TaskState[] = [];
  const queued = tasks.filter((t) => t.status === "queued").sort((a, b) => b.priority - a.priority);
  for (const t of queued) {
    const cap = caps[t.agent];
    if (cap === undefined) continue; // agent not scheduled
    if (pools[t.agent]?.paused) continue; // pool paused (quota)
    const have = projected.get(t.agent) ?? 0;
    if (have >= cap) continue;
    admit.push(t);
    projected.set(t.agent, have + 1);
  }
  return admit;
}
