import type { HandlerDeps } from "../../core/deps.js";
import { queryLoopReports } from "../../core/loop/report.js";
import { discoverRuntimeGuardianFindings } from "../../core/runtime-guardian/inspector.js";
import { DailyTaskAuditStore } from "../../core/tasks/daily-audit-service.js";
import {
  DailyTaskLedger,
  previousSingaporeDayWindow,
  type ScheduledTaskRecord,
  summarizeTaskWindow,
  type TaskWindow,
} from "../../core/tasks/task-ledger.js";
import type { ControlOperationHandler } from "./operations-types.js";

const RECENT_TASK_LIMIT = 50;
const FINDING_SEVERITY_RANK = { high: 0, medium: 1 } as const;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function observedAt(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function recentTaskWindow(now: number): TaskWindow {
  return { start: now - 7 * 24 * 60 * 60 * 1_000, end: now, label: "last 7 days" };
}

export function readDailyTaskAuditObservation(input: {
  now: number;
  ledger: { listForWindow(window: TaskWindow): ScheduledTaskRecord[] };
  auditStore: { getLastFired(): number | undefined };
}) {
  const summaryWindow = previousSingaporeDayWindow(input.now);
  const recentWindow = recentTaskWindow(input.now);
  const summary = summarizeTaskWindow({
    records: input.ledger.listForWindow(summaryWindow),
    now: input.now,
    window: summaryWindow,
  });
  const allRecentRecords = input.ledger
    .listForWindow(recentWindow)
    .sort((a, b) => b.scheduledAt - a.scheduledAt || a.taskId.localeCompare(b.taskId));
  return {
    observedAt: input.now,
    lastFiredAt: input.auditStore.getLastFired() ?? null,
    summary,
    recentWindow,
    recentRecords: allRecentRecords.slice(0, RECENT_TASK_LIMIT),
    recentLimit: RECENT_TASK_LIMIT,
    recentTotal: allRecentRecords.length,
    recentTruncated: allRecentRecords.length > RECENT_TASK_LIMIT,
  };
}

function orderedRuntimeGuardianFindings<
  T extends {
    severity: "medium" | "high";
    runId: string;
    projectId: string;
    kind: string;
  },
>(findings: T[]): T[] {
  return [...findings].sort(
    (left, right) =>
      FINDING_SEVERITY_RANK[left.severity] - FINDING_SEVERITY_RANK[right.severity] ||
      left.projectId.localeCompare(right.projectId) ||
      left.kind.localeCompare(right.kind) ||
      left.runId.localeCompare(right.runId),
  );
}

/** Read-only automation evidence kept behind the Control application boundary. */
export function createControlObservationHandlers(
  deps: HandlerDeps,
  readers: {
    loopReports?: typeof queryLoopReports;
    runtimeGuardianFindings?: typeof discoverRuntimeGuardianFindings;
  } = {},
): {
  loopReports: ControlOperationHandler<
    Extract<Parameters<ControlOperationHandler>[0], { op: "loopReports" }>
  >;
  dailyTaskAuditStatus: ControlOperationHandler<
    Extract<Parameters<ControlOperationHandler>[0], { op: "dailyTaskAuditStatus" }>
  >;
  runtimeGuardianFindings: ControlOperationHandler<
    Extract<Parameters<ControlOperationHandler>[0], { op: "runtimeGuardianFindings" }>
  >;
} {
  const readLoopReports = readers.loopReports ?? queryLoopReports;
  const readRuntimeGuardianFindings =
    readers.runtimeGuardianFindings ?? discoverRuntimeGuardianFindings;
  return {
    loopReports: async (req, { ok, fail }) => {
      if (req.status !== undefined && !["passed", "failed"].includes(req.status)) {
        fail("invalid loop report status");
        return;
      }
      ok(
        readLoopReports({
          limit: boundedInteger(req.limit, 20, 100),
          ...(req.projectId === undefined ? {} : { projectId: req.projectId }),
          ...(req.status === undefined ? {} : { status: req.status }),
        }),
      );
    },
    dailyTaskAuditStatus: async (req, { ok }) => {
      const observationTime = observedAt(req.now);
      ok(
        readDailyTaskAuditObservation({
          now: observationTime,
          ledger: new DailyTaskLedger(),
          auditStore: new DailyTaskAuditStore(),
        }),
      );
    },
    runtimeGuardianFindings: async (req, { ok }) => {
      const observationTime = observedAt(req.now);
      const lookbackHours = boundedInteger(req.lookbackHours, 24, 168);
      const limit = boundedInteger(req.limit, 50, 100);
      const findings = orderedRuntimeGuardianFindings(
        readRuntimeGuardianFindings({
          now: observationTime,
          lookbackMs: lookbackHours * 60 * 60 * 1_000,
          ...(deps.config.runtimeGuardian.repoPath.trim().length > 0
            ? { repoPath: deps.config.runtimeGuardian.repoPath }
            : {}),
        }),
      ).filter((finding) => req.projectId === undefined || finding.projectId === req.projectId);
      ok({
        observedAt: observationTime,
        lookbackHours,
        findings: findings.slice(0, limit),
        total: findings.length,
        limit,
        truncated: findings.length > limit,
      });
    },
  };
}
