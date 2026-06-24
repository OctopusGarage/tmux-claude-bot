import { pauseRun, resumeRun, startPlan, stopRun } from "./controls.js";
import { renderStatus, renderSummary } from "./report.js";
import { SchedulerStore } from "./scheduler-store.js";

/**
 * Shared `/batch <arg>` dispatch for Telegram and Lark adapters.
 * Returns a plain text result string (English, operator-facing — not i18n'd).
 *
 * Verbs:
 *   (none)             → renderStatus of the active run
 *   start <planId>     → startPlan
 *   pause              → pauseRun
 *   resume             → resumeRun
 *   stop               → stopRun
 *   report             → renderSummary of the active run
 */
export function runBatchCommand(arg: string): string {
  const trimmed = arg.trim();
  const store = new SchedulerStore();

  if (!trimmed) {
    return renderStatus(store.getActiveRun());
  }

  const [verb, ...rest] = trimmed.split(/\s+/);

  switch (verb) {
    case "start": {
      const planId = rest.join(" ").trim();
      if (!planId) return "Usage: /batch start <planId>";
      const result = startPlan(store, planId, Date.now());
      return result.ok ? `Batch started: ${planId}` : `Error: ${result.error}`;
    }
    case "pause": {
      const result = pauseRun(store);
      return result.ok ? "Batch paused." : `Error: ${result.error}`;
    }
    case "resume": {
      const result = resumeRun(store);
      return result.ok ? "Batch resumed." : `Error: ${result.error}`;
    }
    case "stop": {
      stopRun(store);
      return "Batch stopped.";
    }
    case "report": {
      const run = store.getActiveRun();
      if (!run) return "No active batch run.";
      return renderSummary(run);
    }
    default:
      return `Unknown verb "${verb}". Usage: /batch [start <planId> | pause | resume | stop | report]`;
  }
}
