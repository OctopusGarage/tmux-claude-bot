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
  input.ledger.reconcileSupersededFailures();
  const ledgerRecords = input.ledger.listForWindow(window);
  const discoveredRecords = input.discover?.({ window, now: input.now }) ?? [];
  const summary = summarizeTaskWindow({
    records: mergeDiscoveredTaskRecords(ledgerRecords, discoveredRecords),
    now: input.now,
    window,
  });
  const repairCandidates = summary.items.filter(
    (item) => isRepairableStatus(item.status) && isRepairDispatchableStatus(item.repairStatus),
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
  const activeIssues = activeIssueItems(input.summary.items);
  return {
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    level: activeIssues.length > 0 ? "warning" : "success",
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
  const activeIssues = activeIssueItems(summary.items);
  const closedFailures = closedFailureItems(summary.items);
  const lines = [
    "Summary:",
    `- success: ${counts.success}`,
    `- failed: ${counts.failed}`,
    `- missing: ${counts.missing}`,
    `- running: ${counts.running}`,
    `- running-timeout: ${counts.runningTimeout}`,
    `- skipped: ${counts.skipped}`,
    `- active-issues: ${activeIssues.length}`,
    `- repair-candidates: ${repairCandidates.length}`,
    `- closed-failures: ${closedFailures.length}`,
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
      item.failureKind ? `  failure-kind: ${item.failureKind}` : "",
      item.error ? `  error: ${item.error}` : "",
      item.summary ? `  summary: ${item.summary}` : "",
      item.reportPath ? `  report: ${item.reportPath}` : "",
    );
  }
  if (repairCandidates.length > 0) {
    lines.push("", "Repair candidates:");
    for (const item of repairCandidates) {
      lines.push(
        `- ${item.taskId}: ${item.status}${
          item.failureKind ? ` kind=${item.failureKind}` : ""
        }${item.error ? ` - ${item.error}` : ""}`,
      );
    }
  }
  const closed = closedFailures;
  if (closed.length > 0) {
    lines.push("", "Closed failures:");
    for (const item of closed) {
      lines.push(`- ${item.taskId}: repair=${item.repairStatus}`);
    }
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

function activeIssueItems(items: TaskAuditItem[]): TaskAuditItem[] {
  return items.filter((item) => {
    if (item.status === "running") return true;
    return isRepairableStatus(item.status) && !isClosedRepairStatus(item.repairStatus);
  });
}

function closedFailureItems(items: TaskAuditItem[]): TaskAuditItem[] {
  return items.filter(
    (item) => isRepairableStatus(item.status) && isClosedRepairStatus(item.repairStatus),
  );
}

function isClosedRepairStatus(status: TaskAuditItem["repairStatus"]): boolean {
  return ["fixed", "not-needed", "blocked", "superseded", "not-reproducible"].includes(
    status ?? "pending",
  );
}

function isRepairDispatchableStatus(status: TaskAuditItem["repairStatus"]): boolean {
  if (status === "running") return false;
  return !isClosedRepairStatus(status);
}

function isRepairableStatus(status: TaskAuditItem["status"]): boolean {
  return ["failed", "missing", "running-timeout"].includes(status);
}
