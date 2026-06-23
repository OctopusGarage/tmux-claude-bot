import type { Run, TaskState } from "./types.js";

const ICON: Record<TaskState["status"], string> = {
  queued: "•",
  running: "▶",
  "awaiting-human": "✋",
  "paused-quota": "⏸",
  done: "✓",
  failed: "✗",
  skipped: "–",
};

const count = (run: Run, s: TaskState["status"]): number =>
  run.tasks.filter((t) => t.status === s).length;

export function renderStatus(run: Run | undefined): string {
  if (!run) return "No active batch run.";
  const done = count(run, "done");
  const lines = run.tasks.map(
    (t) =>
      `${ICON[t.status]} ${t.project} [${t.agent}] ${t.goalsCompleted.length}/${t.goals.length}`,
  );
  return [`Batch ${run.runId} (${run.status}) — ${done}/${run.tasks.length} done`, ...lines].join(
    "\n",
  );
}

export function renderSummary(run: Run): string {
  const failed = run.tasks.filter((t) => t.status === "failed");
  const dur = run.endedAt ? ` in ${Math.round((run.endedAt - run.startedAt) / 1000)}s` : "";
  const head = `Batch ${run.runId} ${run.status}${dur}: ${count(run, "done")} done, ${count(run, "failed")} failed, ${count(run, "skipped")} skipped`;
  const fails = failed.map((t) => `  ✗ ${t.project}: ${t.error ?? "unknown"}`);
  return [head, ...fails].join("\n");
}
