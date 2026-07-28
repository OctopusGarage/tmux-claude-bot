import type {
  NotificationChannelSelection,
  NotificationRequest,
} from "../notifications/gateway.js";
import { mergeDiscoveredTaskRecords } from "./task-discovery.js";
import {
  type DailyTaskLedger,
  previousSingaporeDayWindow,
  summarizeTaskWindow,
  type TaskAuditItem,
  type TaskAuditSummary,
} from "./task-ledger.js";

export type DailyTaskAuditResult = {
  summary: TaskAuditSummary;
  repairCandidates: TaskAuditItem[];
};

export type DailyTaskAuditNotify = (request: NotificationRequest) => Promise<unknown>;
export type ScheduledTaskDiscovery = (input: {
  window: ReturnType<typeof previousSingaporeDayWindow>;
  now: number;
}) => import("./task-ledger.js").ScheduledTaskRecord[];

export async function runDailyTaskAudit(input: {
  now: number;
  ledger: DailyTaskLedger;
  notify?: DailyTaskAuditNotify;
  channel?: NotificationChannelSelection;
  discover?: ScheduledTaskDiscovery;
}): Promise<DailyTaskAuditResult> {
  const window = previousSingaporeDayWindow(input.now);
  const ledgerRecords = input.ledger.listForWindow(window);
  const discoveredRecords = input.discover?.({ window, now: input.now }) ?? [];
  const summary = summarizeTaskWindow({
    records: mergeDiscoveredTaskRecords(ledgerRecords, discoveredRecords),
    now: input.now,
    window,
  });
  const repairCandidates = summary.items.filter(
    (item) =>
      ["failed", "missing", "running-timeout"].includes(item.status) &&
      !["fixed", "not-needed", "blocked"].includes(item.repairStatus ?? "pending"),
  );
  if (input.notify !== undefined) {
    await input.notify(
      buildDailyTaskAuditNotification({
        summary,
        repairCandidates,
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
      }),
    );
  }
  return { summary, repairCandidates };
}

export function buildDailyTaskAuditNotification(input: {
  summary: TaskAuditSummary;
  repairCandidates: TaskAuditItem[];
  channel?: NotificationChannelSelection;
  repairDispatch?: string;
}): NotificationRequest {
  return {
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    level: input.repairCandidates.length > 0 ? "warning" : "success",
    source: "daily-task-audit",
    title: `Daily scheduled task audit: ${input.summary.window?.label ?? "unknown window"}`,
    body: renderDailyTaskAudit(input.summary, input.repairCandidates, {
      ...(input.repairDispatch !== undefined ? { repairDispatch: input.repairDispatch } : {}),
    }),
  };
}

export function renderDailyTaskAudit(
  summary: TaskAuditSummary,
  repairCandidates: TaskAuditItem[],
  opts: { repairDispatch?: string } = {},
): string {
  const counts = summary.counts;
  const lines = [
    "Summary:",
    `- success: ${counts.success}`,
    `- failed: ${counts.failed}`,
    `- missing: ${counts.missing}`,
    `- running: ${counts.running}`,
    `- running-timeout: ${counts.runningTimeout}`,
    `- skipped: ${counts.skipped}`,
  ];
  if (opts.repairDispatch !== undefined) {
    lines.push(`- repair-dispatch: ${opts.repairDispatch}`);
  }
  if (summary.items.length === 0) {
    lines.push("", "No scheduled task records were found for this window.");
    return lines.join("\n");
  }
  lines.push("", "Tasks:");
  for (const item of summary.items) {
    lines.push(
      `- ${item.status}: ${item.name} (${item.source})`,
      `  taskId: ${item.taskId}`,
      item.repairStatus ? `  repair: ${item.repairStatus}` : "",
      item.error ? `  error: ${item.error}` : "",
      item.summary ? `  summary: ${item.summary}` : "",
      item.reportPath ? `  report: ${item.reportPath}` : "",
    );
  }
  if (repairCandidates.length > 0) {
    lines.push("", "Repair candidates:");
    for (const item of repairCandidates) {
      lines.push(`- ${item.taskId}: ${item.status}${item.error ? ` - ${item.error}` : ""}`);
    }
  }
  return lines.filter((line) => line.length > 0).join("\n");
}
