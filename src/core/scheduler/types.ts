import type { AgentKind } from "../agents/types.js";

export type Schedule =
  | { kind: "now" }
  | { kind: "at"; at: number }
  | { kind: "cron"; cron: string };

export type ProjectSpec = {
  path: string;
  agent: AgentKind;
  goals: string[];
  rounds?: number;
  retries?: number;
  priority?: number;
};

export type Plan = {
  id: string;
  name: string;
  pools: Partial<Record<AgentKind, number>>;
  schedule?: Schedule;
  defaults?: { rounds?: number; retries?: number };
  projects: ProjectSpec[];
};

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting-human"
  | "paused-quota"
  | "done"
  | "failed"
  | "skipped";

export type TaskState = {
  project: string; // workspace path
  agent: AgentKind;
  goals: string[];
  rounds: number;
  retries: number;
  priority: number;
  sessionName?: string;
  status: TaskStatus;
  attempt: number; // 0-based; bumped on retry
  resuming?: boolean; // re-admit after a gate/quota pause
  startedAt?: number;
  endedAt?: number;
  goalsCompleted: string[];
  error?: string;
};

export type Run = {
  runId: string;
  planId: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "paused" | "done";
  tasks: TaskState[];
};

export type PoolState = { paused: boolean; resumeAt?: number };

/** The terminal task states — a task in one of these is done progressing.
 * Shared by the scheduler loop and the control handlers so they agree. */
export const TERMINAL_STATUSES: ReadonlySet<TaskState["status"]> = new Set<TaskState["status"]>([
  "done",
  "failed",
  "skipped",
]);
