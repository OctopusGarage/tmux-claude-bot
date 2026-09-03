import { classifyAgentTransientFailure } from "../agents/transient-failure.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import { isBotOwnedRetryableRecoveryEvidence } from "./project-recovery.js";

export const SCHEDULED_TASK_SOURCES = [
  "loop-engineering",
  "batch-scheduler",
  "article-monitor",
  "radar-monitor",
  "external-monitor",
  "launchd",
  "daily-audit",
  "autopilot-delegate",
  "system-self-heal",
] as const;

export type ScheduledTaskSource = (typeof SCHEDULED_TASK_SOURCES)[number];

export type ScheduledTaskStatus =
  | "expected"
  | "running"
  | "success"
  | "failed"
  | "missing"
  | "running-timeout"
  | "skipped";

export type ScheduledTaskFailureKind =
  | "agent-capacity"
  | "dirty-worktree"
  | "external-ci"
  | "github-permission"
  | "invalid-final-summary"
  | "system-gate"
  | "agent-timeout"
  | "missing-instrumentation"
  | "external-service"
  | "unknown";

export type ScheduledTaskRepairStatus =
  | "not-needed"
  | "pending"
  | "running"
  | "completed"
  | "fixed"
  | "blocked"
  | "failed"
  | "superseded"
  | "not-reproducible";

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
  failureKind?: ScheduledTaskFailureKind;
  reportPath?: string;
  repairStatus?: ScheduledTaskRepairStatus;
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
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SYSTEM_SELF_HEAL_DEFERRED_PREFIX =
  "System self-heal agent sweep deferred before WorkOrder creation: ";

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
    delete record.error;
    delete record.failureKind;
    this.store.set(taskId, record);
    this.supersedeEarlierFailures(record);
    return record;
  }

  fail(
    taskId: string,
    input: { endedAt: number; error: string; summary?: string; reportPath?: string },
  ): ScheduledTaskRecord | null {
    const existing = this.store.get(taskId);
    if (!existing) return null;
    const preserveClosedRepair = isNonRetryableProjectRecoveryClosure(existing);
    const record: ScheduledTaskRecord = {
      ...existing,
      status: "failed",
      endedAt: input.endedAt,
      error: input.error,
      failureKind: classifyTaskFailure(input.error, input.summary),
      repairStatus: preserveClosedRepair ? "blocked" : "pending",
      ...(input.summary !== undefined && !preserveClosedRepair ? { summary: input.summary } : {}),
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
    delete record.error;
    delete record.failureKind;
    this.store.set(taskId, record);
    return record;
  }

  markRepairStatus(
    taskId: string,
    input: {
      repairStatus: ScheduledTaskRepairStatus;
      updatedAt: number;
      summary?: string;
      error?: string;
    },
  ): ScheduledTaskRecord | null {
    const existing = this.store.get(taskId);
    if (!existing) return null;
    if (
      isNonRetryableProjectRecoveryClosure(existing) &&
      (input.repairStatus === "pending" || input.repairStatus === "running")
    ) {
      return existing;
    }
    const record: ScheduledTaskRecord = {
      ...existing,
      repairStatus: input.repairStatus,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.error !== undefined || input.summary !== undefined
        ? {
            failureKind: classifyTaskFailure(
              input.error ?? existing.error,
              input.summary ?? existing.summary,
            ),
          }
        : {}),
      updatedAt: input.updatedAt,
    };
    this.store.set(taskId, record);
    return record;
  }

  reconcileTerminalStatuses(now: number): number {
    let updated = 0;
    this.store.update((records) => {
      for (const [taskId, record] of Object.entries(records)) {
        if (!["success", "skipped"].includes(record.status)) continue;
        if (record.repairStatus === "not-needed") continue;
        records[taskId] = {
          ...record,
          repairStatus: "not-needed",
          summary: appendSummary(
            record.summary,
            "Normalized terminal task state: successful or skipped task needs no repair.",
          ),
          updatedAt: now,
        };
        updated++;
      }
      return updated > 0;
    });
    return updated;
  }

  reconcileDeferredSystemSelfHealSweeps(now: number): number {
    let updated = 0;
    this.store.update((records) => {
      for (const [taskId, record] of Object.entries(records)) {
        if (record.source !== "system-self-heal") continue;
        if (record.status !== "skipped" || record.repairStatus !== "not-needed") continue;
        const summary = record.summary ?? "";
        if (!summary.startsWith(SYSTEM_SELF_HEAL_DEFERRED_PREFIX)) continue;
        const reason = summary.slice(SYSTEM_SELF_HEAL_DEFERRED_PREFIX.length).trim() || "unknown";
        records[taskId] = {
          ...record,
          status: "failed",
          error: reason,
          failureKind: classifyTaskFailure(reason, summary),
          repairStatus: "pending",
          summary: appendSummary(
            summary,
            "Reopened legacy deferred system self-heal sweep as retryable repair evidence.",
          ),
          updatedAt: now,
        };
        updated++;
      }
      return updated > 0;
    });
    return updated;
  }

  reconcileStaleRunning(
    now: number,
    input: { timeoutMs?: number; sources?: ScheduledTaskSource[] } = {},
  ): number {
    const timeoutMs = input.timeoutMs ?? RUNNING_TIMEOUT_MS;
    const sources = input.sources === undefined ? null : new Set(input.sources);
    let updated = 0;
    this.store.update((records) => {
      for (const [taskId, record] of Object.entries(records)) {
        if (record.status !== "running") continue;
        if (sources !== null && !sources.has(record.source)) continue;
        if (now - record.updatedAt < timeoutMs) continue;
        records[taskId] = {
          ...record,
          status: "running-timeout",
          endedAt: now,
          error: `Task execution exceeded the ${Math.round(timeoutMs / 60_000)} minute recovery timeout.`,
          failureKind: "agent-timeout",
          repairStatus: "pending",
          summary: appendSummary(
            record.summary,
            "Reconciled stale running task after its execution owner disappeared.",
          ),
          updatedAt: now,
        };
        updated++;
      }
      return updated > 0;
    });
    return updated;
  }

  reconcileExpectedMissing(now: number, input: { sources?: ScheduledTaskSource[] } = {}): number {
    const sources = input.sources === undefined ? null : new Set(input.sources);
    let updated = 0;
    this.store.update((records) => {
      for (const [taskId, record] of Object.entries(records)) {
        if (record.status !== "expected") continue;
        if (record.scheduledAt > now) continue;
        if (sources !== null && !sources.has(record.source)) continue;
        records[taskId] = {
          ...record,
          status: "missing",
          repairStatus: "pending",
          summary: appendSummary(
            record.summary,
            "Reconciled missing expected task after its scheduled time passed without a run record.",
          ),
          updatedAt: now,
        };
        updated++;
      }
      return updated > 0;
    });
    return updated;
  }

  reconcileSupersededFailures(): number {
    let updated = 0;
    this.store.update((records) => {
      const entries = Object.entries(records).sort(([a], [b]) => a.localeCompare(b));
      const successes = entries
        .map(([, record]) => record)
        .filter((record) => record.status === "success")
        .sort((a, b) => a.scheduledAt - b.scheduledAt || a.taskId.localeCompare(b.taskId));
      for (const success of successes) {
        for (const [taskId, record] of entries) {
          const current = records[taskId] ?? record;
          if (current.taskId === success.taskId) continue;
          if (current.source !== success.source || current.name !== success.name) continue;
          if (current.scheduledAt >= success.scheduledAt) continue;
          if (!isUnresolvedRepairCandidate(current)) continue;
          records[taskId] = {
            ...current,
            repairStatus: "superseded",
            summary: appendSummary(
              current.summary,
              `Superseded by later successful task ${success.taskId}.`,
            ),
            updatedAt: success.endedAt ?? success.updatedAt,
          };
          updated++;
        }
      }
      return updated > 0;
    });
    return updated;
  }

  listAll(): ScheduledTaskRecord[] {
    return this.store
      .sortedEntries()
      .map(([, record]) => record)
      .sort((a, b) => a.scheduledAt - b.scheduledAt || a.taskId.localeCompare(b.taskId));
  }

  listForWindow(window: TaskWindow): ScheduledTaskRecord[] {
    return this.store
      .sortedEntries()
      .map(([, record]) => record)
      .filter((record) => record.scheduledAt >= window.start && record.scheduledAt < window.end)
      .sort((a, b) => a.scheduledAt - b.scheduledAt || a.taskId.localeCompare(b.taskId));
  }

  private supersedeEarlierFailures(success: ScheduledTaskRecord): number {
    let updated = 0;
    this.store.update((records) => {
      for (const [taskId, record] of Object.entries(records)) {
        if (record.taskId === success.taskId) continue;
        if (record.source !== success.source || record.name !== success.name) continue;
        if (record.scheduledAt >= success.scheduledAt) continue;
        if (!isUnresolvedRepairCandidate(record)) continue;
        records[taskId] = {
          ...record,
          repairStatus: "superseded",
          summary: appendSummary(
            record.summary,
            `Superseded by later successful task ${success.taskId}.`,
          ),
          updatedAt: success.endedAt ?? success.updatedAt,
        };
        updated++;
      }
      return updated > 0;
    });
    return updated;
  }

  pruneTerminal(now: number, retentionMs: number = TERMINAL_RETENTION_MS): number {
    let deleted = 0;
    this.store.update((records) => {
      for (const [taskId, record] of Object.entries(records)) {
        if (!isTerminalTaskRecord(record)) continue;
        const referenceAt = record.scheduledAt;
        if (referenceAt > now || now - referenceAt <= retentionMs) continue;
        delete records[taskId];
        deleted++;
      }
      return deleted > 0;
    });
    return deleted;
  }
}

export function classifyTaskFailure(
  error: string | undefined,
  summary: string | undefined,
): ScheduledTaskFailureKind {
  const text = `${error ?? ""}\n${summary ?? ""}`.toLowerCase();
  const transient = classifyAgentTransientFailure(text);
  if (transient?.kind === "model-capacity" || transient?.kind === "rate-limit")
    return "agent-capacity";
  if (text.includes("dirty") || text.includes("worktree is dirty")) return "dirty-worktree";
  if (text.includes("github account") || text.includes("must be a collaborator"))
    return "github-permission";
  if (
    text.includes("invalid-output") ||
    text.includes("missing-final-marker") ||
    text.includes("final summary") ||
    text.includes("status passed") ||
    text.includes("status complete")
  ) {
    return "invalid-final-summary";
  }
  if (text.includes("ci check") || text.includes("statuscheckrollup")) return "external-ci";
  if (text.includes("network") || text.includes("socket") || text.includes("tls handshake"))
    return "external-service";
  if (
    text.includes("automation admission deferred") ||
    text.includes("project already has active automation")
  ) {
    return "system-gate";
  }
  if (text.includes("did not become ready") || text.includes("timeout")) return "agent-timeout";
  if (text.includes("missing instrumentation") || text.includes("missing output"))
    return "missing-instrumentation";
  if (text.includes("supervised system gate failed")) return "system-gate";
  return "unknown";
}

function isNonRetryableProjectRecoveryClosure(record: ScheduledTaskRecord): boolean {
  const summary = record.summary?.toLowerCase() ?? "";
  return (
    record.repairStatus === "blocked" &&
    summary.includes("closed from the authoritative accepted blocked project recovery") &&
    summary.includes("no retryable project repair remains") &&
    !isBotOwnedRetryableRecoveryEvidence(summary)
  );
}

function isUnresolvedRepairCandidate(record: ScheduledTaskRecord): boolean {
  if (!["failed", "missing", "running-timeout"].includes(record.status)) return false;
  return !["fixed", "not-needed", "blocked", "superseded", "not-reproducible"].includes(
    record.repairStatus ?? "pending",
  );
}

function isTerminalTaskRecord(record: ScheduledTaskRecord): boolean {
  if (record.status === "running" || record.status === "expected" || record.status === "missing") {
    return false;
  }
  if (record.repairStatus === undefined) return false;
  return ["fixed", "not-needed", "blocked", "not-reproducible", "superseded"].includes(
    record.repairStatus,
  );
}

function appendSummary(current: string | undefined, addition: string): string {
  if (current === undefined || current.trim().length === 0) return addition;
  if (current.includes(addition)) return current;
  return `${current}; ${addition}`;
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
