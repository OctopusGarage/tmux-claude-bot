import {
  DailyTaskLedger,
  type ScheduledTaskRepairStatus,
  type ScheduledTaskSource,
} from "./task-ledger.js";

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
  repairStatus?: ScheduledTaskRepairStatus;
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
    const updatedAt = input.startedAt ?? Date.now();
    ledger.start(input.taskId, updatedAt);
    recordRepairStatus(ledger, input, updatedAt);
    return;
  }
  if (input.status === "success") {
    const updatedAt = input.endedAt ?? Date.now();
    ledger.finish(input.taskId, {
      endedAt: updatedAt,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
    });
    recordRepairStatus(ledger, input, updatedAt);
    return;
  }
  if (input.status === "skipped") {
    const updatedAt = input.endedAt ?? Date.now();
    ledger.skip(input.taskId, {
      endedAt: updatedAt,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    });
    recordRepairStatus(ledger, input, updatedAt);
    return;
  }
  const updatedAt = input.endedAt ?? Date.now();
  ledger.fail(input.taskId, {
    endedAt: updatedAt,
    error: input.error ?? "external task reported failure",
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
  });
  recordRepairStatus(ledger, input, updatedAt);
}

function recordRepairStatus(
  ledger: DailyTaskLedger,
  input: {
    taskId: string;
    repairStatus?: ScheduledTaskRepairStatus;
    summary?: string;
    error?: string;
  },
  updatedAt: number,
): void {
  if (input.repairStatus !== undefined) {
    ledger.markRepairStatus(input.taskId, {
      repairStatus: input.repairStatus,
      updatedAt,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    });
  }
}

function assertFiniteTime(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`invalid ${name}: ${String(value)}`);
}
