import { JsonMapStore } from "../infra/json-map-store.js";

export type ScheduledTaskSource =
  | "loop-engineering"
  | "batch-scheduler"
  | "article-monitor"
  | "radar-monitor"
  | "external-monitor"
  | "launchd"
  | "daily-audit";

export type ScheduledTaskStatus =
  | "expected"
  | "running"
  | "success"
  | "failed"
  | "missing"
  | "running-timeout"
  | "skipped";

export type ScheduledTaskRecord = {
  taskId: string;
  source: ScheduledTaskSource;
  name: string;
  scheduledAt: number;
  status: ScheduledTaskStatus;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  reportPath?: string;
  repairStatus?: "not-needed" | "pending" | "running" | "fixed" | "blocked" | "failed";
  updatedAt: number;
};

export type TaskWindow = {
  start: number;
  end: number;
  label: string;
};

export type TaskAuditItem = ScheduledTaskRecord & {
  status: Exclude<ScheduledTaskStatus, "expected">;
};

export type TaskAuditSummary = {
  window: TaskWindow | null;
  counts: {
    success: number;
    failed: number;
    missing: number;
    running: number;
    runningTimeout: number;
    skipped: number;
  };
  items: TaskAuditItem[];
};

const RUNNING_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export class DailyTaskLedger {
  private readonly store = new JsonMapStore<ScheduledTaskRecord>("scheduled_task_ledger.json");

  expect(input: {
    taskId: string;
    source: ScheduledTaskSource;
    name: string;
    scheduledAt: number;
    summary?: string;
  }): ScheduledTaskRecord {
    const existing = this.store.get(input.taskId);
    if (existing && existing.status !== "expected") return existing;
    const record: ScheduledTaskRecord = {
      taskId: input.taskId,
      source: input.source,
      name: input.name,
      scheduledAt: input.scheduledAt,
      status: "expected",
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      updatedAt: Date.now(),
    };
    this.store.set(input.taskId, record);
    return record;
  }

  start(taskId: string, startedAt: number): ScheduledTaskRecord | null {
    const existing = this.store.get(taskId);
    if (!existing) return null;
    const record: ScheduledTaskRecord = {
      ...existing,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    };
    this.store.set(taskId, record);
    return record;
  }

  finish(
    taskId: string,
    input: { endedAt: number; summary?: string; reportPath?: string },
  ): ScheduledTaskRecord | null {
    const existing = this.store.get(taskId);
    if (!existing) return null;
    const record: ScheduledTaskRecord = {
      ...existing,
      status: "success",
      endedAt: input.endedAt,
      repairStatus: "not-needed",
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
      updatedAt: input.endedAt,
    };
    this.store.set(taskId, record);
    return record;
  }

  fail(
    taskId: string,
    input: { endedAt: number; error: string; summary?: string; reportPath?: string },
  ): ScheduledTaskRecord | null {
    const existing = this.store.get(taskId);
    if (!existing) return null;
    const record: ScheduledTaskRecord = {
      ...existing,
      status: "failed",
      endedAt: input.endedAt,
      error: input.error,
      repairStatus: "pending",
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
      updatedAt: input.endedAt,
    };
    this.store.set(taskId, record);
    return record;
  }

  skip(taskId: string, input: { endedAt: number; summary?: string }): ScheduledTaskRecord | null {
    const existing = this.store.get(taskId);
    if (!existing) return null;
    const record: ScheduledTaskRecord = {
      ...existing,
      status: "skipped",
      endedAt: input.endedAt,
      repairStatus: "not-needed",
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      updatedAt: input.endedAt,
    };
    this.store.set(taskId, record);
    return record;
  }

  listForWindow(window: TaskWindow): ScheduledTaskRecord[] {
    return this.store
      .sortedEntries()
      .map(([, record]) => record)
      .filter((record) => record.scheduledAt >= window.start && record.scheduledAt < window.end)
      .sort((a, b) => a.scheduledAt - b.scheduledAt || a.taskId.localeCompare(b.taskId));
  }
}

export function singaporeDayWindow(day: string): TaskWindow {
  return {
    start: Date.parse(`${day}T00:00:00+08:00`),
    end: Date.parse(`${day}T00:00:00+08:00`) + 24 * 60 * 60 * 1000,
    label: `${day} SGT`,
  };
}

export function previousSingaporeDayWindow(now: number): TaskWindow {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  const day = shifted.toISOString().slice(0, 10);
  return singaporeDayWindow(day);
}

export function summarizeTaskWindow(input: {
  records: ScheduledTaskRecord[];
  now: number;
  window?: TaskWindow;
  runningTimeoutMs?: number;
}): TaskAuditSummary {
  const timeoutMs = input.runningTimeoutMs ?? RUNNING_TIMEOUT_MS;
  const items = input.records.map((record): TaskAuditItem => {
    if (record.status === "expected") return { ...record, status: "missing" };
    if (
      record.status === "running" &&
      input.now - (record.startedAt ?? record.scheduledAt) > timeoutMs
    ) {
      return { ...record, status: "running-timeout", repairStatus: "pending" };
    }
    if (record.status === "running") return record as TaskAuditItem;
    return record as TaskAuditItem;
  });
  return {
    window: input.window ?? null,
    counts: {
      success: items.filter((item) => item.status === "success").length,
      failed: items.filter((item) => item.status === "failed").length,
      missing: items.filter((item) => item.status === "missing").length,
      running: items.filter((item) => item.status === "running").length,
      runningTimeout: items.filter((item) => item.status === "running-timeout").length,
      skipped: items.filter((item) => item.status === "skipped").length,
    },
    items,
  };
}
