import type { Run } from "./types.js";

/** An awaiting-human task whose session has un-gated (you confirmed) returns to the
 * queue with resuming=true, so reconcile re-enables it WITHOUT resetting its cycle. */
export function resumeUngatedTasks(run: Run, isGated: (session: string) => boolean): Run {
  return {
    ...run,
    tasks: run.tasks.map((t) =>
      t.status === "awaiting-human" && t.sessionName !== undefined && !isGated(t.sessionName)
        ? { ...t, status: "queued", resuming: true }
        : t,
    ),
  };
}
