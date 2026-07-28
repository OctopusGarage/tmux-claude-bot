import { DailyTaskLedger, type ScheduledTaskSource } from "./task-ledger.js";

export type ExternalTaskReportStatus = "running" | "success" | "failed" | "skipped";

export function recordExternalTaskReport(input: {
  taskId: string;
  source: ScheduledTaskSource;
  name: string;
  scheduledAt: number;
  status: ExternalTaskReportStatus;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  reportPath?: string;
}): void {
  assertFiniteTime("scheduledAt", input.scheduledAt);
  if (input.startedAt !== undefined) assertFiniteTime("startedAt", input.startedAt);
  if (input.endedAt !== undefined) assertFiniteTime("endedAt", input.endedAt);
  const ledger = new DailyTaskLedger();
  ledger.expect({
    taskId: input.taskId,
    source: input.source,
    name: input.name,
    scheduledAt: input.scheduledAt,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  });
  if (input.status === "running") {
    ledger.start(input.taskId, input.startedAt ?? Date.now());
    return;
  }
  if (input.status === "success") {
    ledger.finish(input.taskId, {
      endedAt: input.endedAt ?? Date.now(),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
    });
    return;
  }
  if (input.status === "skipped") {
    ledger.skip(input.taskId, {
      endedAt: input.endedAt ?? Date.now(),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    });
    return;
  }
  ledger.fail(input.taskId, {
    endedAt: input.endedAt ?? Date.now(),
    error: input.error ?? "external task reported failure",
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
  });
}

function assertFiniteTime(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`invalid ${name}: ${String(value)}`);
}
