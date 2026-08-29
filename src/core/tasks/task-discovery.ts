import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LOOP_RUN_ARTIFACTS, loopRunsRoot } from "../loop/artifacts.js";
import type { LoopConfig } from "../loop/config.js";
import { parseLoopConfigYaml } from "../loop/config.js";
import {
  type LoopJitterJobKind,
  loopScheduleJitterMaxMs,
  loopScheduleJitterMs,
} from "../loop/schedule-jitter.js";
import { loopScheduledJobs } from "../loop/task-family.js";
import { nextFire } from "../scheduling/occurrence.js";
import type { ScheduledTaskRecord, TaskWindow } from "./task-ledger.js";

type LoopDiscoveredJobKind = LoopJitterJobKind;

type LaunchdPlist = {
  label: string;
  scheduled: boolean;
  stdoutPath?: string;
  stderrPath?: string;
};

export function mergeDiscoveredTaskRecords(
  ledgerRecords: ScheduledTaskRecord[],
  discoveredRecords: ScheduledTaskRecord[],
): ScheduledTaskRecord[] {
  const merged = new Map<string, ScheduledTaskRecord>();
  for (const record of discoveredRecords) merged.set(record.taskId, record);
  for (const record of ledgerRecords) {
    const reconciled = reconcileLoopLedgerArtifact(record);
    const discovered = merged.get(reconciled.taskId);
    if (discovered !== undefined && shouldPreferDiscoveredRecord(reconciled, discovered)) {
      merged.set(reconciled.taskId, mergeClosedRepairResolution(reconciled, discovered));
      continue;
    }
    merged.set(reconciled.taskId, reconciled);
  }
  return [...merged.values()].sort(
    (a, b) => a.scheduledAt - b.scheduledAt || a.taskId.localeCompare(b.taskId),
  );
}

function shouldPreferDiscoveredRecord(
  ledgerRecord: ScheduledTaskRecord,
  discoveredRecord: ScheduledTaskRecord,
): boolean {
  if (
    ledgerRecord.source === "loop-engineering" &&
    discoveredRecord.source === "loop-engineering" &&
    isClosedTerminalStatus(ledgerRecord) &&
    (ledgerRecord.updatedAt >= discoveredRecord.updatedAt ||
      isCompletedFinalSummaryAnomalyRecord(discoveredRecord))
  ) {
    return false;
  }
  return (
    ledgerRecord.source === "loop-engineering" &&
    discoveredRecord.source === "loop-engineering" &&
    discoveredRecord.status !== "expected"
  );
}

function isClosedTerminalStatus(record: ScheduledTaskRecord): boolean {
  return (
    (record.status === "success" || record.status === "skipped") &&
    isClosedRepairStatus(record.repairStatus)
  );
}

function mergeClosedRepairResolution(
  ledgerRecord: ScheduledTaskRecord,
  discoveredRecord: ScheduledTaskRecord,
): ScheduledTaskRecord {
  if (
    ledgerRecord.source !== "loop-engineering" ||
    discoveredRecord.source !== "loop-engineering" ||
    !isRepairableStatus(ledgerRecord.status) ||
    !isClosedRepairStatus(ledgerRecord.repairStatus) ||
    !isRepairableStatus(discoveredRecord.status)
  ) {
    return discoveredRecord;
  }
  const repairStatus = ledgerRecord.repairStatus;
  if (repairStatus === undefined) return discoveredRecord;
  return {
    ...discoveredRecord,
    repairStatus,
    ...(ledgerRecord.error !== undefined ? { error: ledgerRecord.error } : {}),
    ...(ledgerRecord.failureKind !== undefined ? { failureKind: ledgerRecord.failureKind } : {}),
    ...(ledgerRecord.summary !== undefined ? { summary: ledgerRecord.summary } : {}),
    updatedAt: Math.max(ledgerRecord.updatedAt, discoveredRecord.updatedAt),
  };
}

function isClosedRepairStatus(status: ScheduledTaskRecord["repairStatus"]): boolean {
  return ["fixed", "not-needed", "blocked", "superseded", "not-reproducible"].includes(
    status ?? "pending",
  );
}

function isRepairableStatus(status: ScheduledTaskRecord["status"]): boolean {
  return ["failed", "missing", "running-timeout"].includes(status);
}

function isCompletedFinalSummaryAnomalyRecord(record: ScheduledTaskRecord): boolean {
  return (
    record.error?.startsWith("loop supervisor completed with unresolved risky follow-up") === true
  );
}

function reconcileLoopLedgerArtifact(record: ScheduledTaskRecord): ScheduledTaskRecord {
  if (record.source !== "loop-engineering") return record;
  const finalSummaryPath = finalSummaryPathForLedgerRecord(record);
  if (finalSummaryPath === null) return record;
  const reconciled = recordForSupervisorArtifacts({
    projectId: projectIdFromLoopTaskId(record.taskId) ?? projectIdFromLoopTaskName(record.name),
    jobKind: jobKindFromLoopTaskId(record.taskId),
    scheduledAt: record.scheduledAt,
    taskId: record.taskId,
    now: Math.max(record.updatedAt, record.endedAt ?? record.startedAt ?? record.scheduledAt),
    runDir: dirname(finalSummaryPath),
    finalSummaryPath,
  });
  if (reconciled === null) return record;
  if (
    isClosedTerminalStatus(record) &&
    isRepairableStatus(reconciled.status) &&
    isCompletedFinalSummaryAnomalyRecord(reconciled)
  ) {
    return record;
  }
  return mergeClosedRepairResolution(record, reconciled);
}

function finalSummaryPathForLedgerRecord(record: ScheduledTaskRecord): string | null {
  if (record.reportPath !== undefined) {
    const fromReport = finalSummaryPathNearReport(record.reportPath);
    if (fromReport !== null) return fromReport;
  }
  const projectId =
    projectIdFromLoopTaskId(record.taskId) ?? projectIdFromLoopTaskName(record.name);
  if (projectId === "unknown") return null;
  const runRoot = join(loopRunsRoot(), projectId);
  if (!existsSync(runRoot)) return null;
  const prefix = `${record.scheduledAt}-`;
  for (const name of readdirSync(runRoot)) {
    if (!name.startsWith(prefix)) continue;
    const candidate = join(runRoot, name, LOOP_RUN_ARTIFACTS.supervisorFinalSummary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function finalSummaryPathNearReport(reportPath: string): string | null {
  const candidates = [
    join(dirname(reportPath), LOOP_RUN_ARTIFACTS.supervisorFinalSummary),
    reportPath.replace(/supervisor(?:-summary)?\.json$/, LOOP_RUN_ARTIFACTS.supervisorFinalSummary),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function projectIdFromLoopTaskId(taskId: string): string | null {
  const parts = taskId.split(":");
  if (parts[0] !== "loop") return null;
  if (parts[1] === "pr-review") return parts[2] ?? null;
  if (parts[1] === "workspace") return parts[2] ?? null;
  return parts[1] ?? null;
}

function jobKindFromLoopTaskId(taskId: string): LoopDiscoveredJobKind {
  const parts = taskId.split(":");
  if (parts[1] === "pr-review") return "repository-pull-request-review";
  if (parts[1] === "workspace") return taskKindFromName(parts[3]);
  return parts.length === 3 ? "architecture" : taskKindFromName(parts[2]);
}

function projectIdFromLoopTaskName(name: string): string {
  return name.split(/\s+/)[0] ?? "unknown";
}

function taskKindFromName(value: string | undefined): LoopDiscoveredJobKind {
  if (value === "bug-fix") return "bug-fix";
  if (value === "test-coverage") return "test-coverage";
  if (value === "security-maintenance") return "security-maintenance";
  if (value === "harness-auto") return "harness-auto";
  if (value === "opportunity-discovery") return "opportunity-discovery";
  if (value === "automation-governance-review") return "automation-governance-review";
  if (value === "pull-request-review") return "pull-request-review";
  if (value === "repository-pull-request-review") return "repository-pull-request-review";
  if (value === "workspace-architecture") return "workspace-architecture";
  return "architecture";
}

export function discoverLaunchdScheduledTasks(input: {
  window: TaskWindow;
  now: number;
  dirs?: string[];
  fileTime?: (path: string) => number | null;
  launchctlState?: (label: string) => string | null;
  includeLabel?: (label: string) => boolean;
}): ScheduledTaskRecord[] {
  const dirs = input.dirs ?? [join(homedir(), "Library", "LaunchAgents")];
  const fileTime = input.fileTime ?? defaultFileTime;
  const launchctlState = input.launchctlState ?? defaultLaunchctlState;
  const records: ScheduledTaskRecord[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".plist")) continue;
      const plist = parseLaunchdPlist(join(dir, name));
      if (!plist?.scheduled) continue;
      if (input.includeLabel && !input.includeLabel(plist.label)) continue;
      records.push(recordForLaunchdPlist(plist, input.window, input.now, fileTime, launchctlState));
    }
  }
  return records.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function discoverLoopEngineeringScheduledTasks(input: {
  window: TaskWindow;
  now: number;
  configFile?: string;
  loopRunsDir?: string;
}): ScheduledTaskRecord[] {
  const configFile = input.configFile?.trim();
  if (!configFile) return [];
  let config: ReturnType<typeof parseLoopConfigYaml>;
  try {
    config = parseLoopConfigYaml(readFileSync(configFile, "utf8"));
  } catch {
    return [];
  }
  const records = loopScheduledJobs(config).flatMap((job) =>
    loopScheduleRecords({
      projectId: job.project.id,
      jobKey: job.jobKey,
      jobKind: job.jobKind,
      schedule: job.schedule,
      config,
      window: input.window,
      now: input.now,
      ...(job.scheduleJitterMinutes !== undefined
        ? { scheduleJitterMinutes: job.scheduleJitterMinutes }
        : {}),
      ...(input.loopRunsDir !== undefined ? { loopRunsDir: input.loopRunsDir } : {}),
    }),
  );
  return records.sort((a, b) => a.scheduledAt - b.scheduledAt || a.taskId.localeCompare(b.taskId));
}

function loopScheduleRecords(input: {
  projectId: string;
  jobKey: string;
  jobKind: LoopDiscoveredJobKind;
  schedule: string | undefined;
  scheduleJitterMinutes?: number;
  config: LoopConfig;
  window: TaskWindow;
  now: number;
  loopRunsDir?: string;
}): ScheduledTaskRecord[] {
  if (input.schedule === undefined) return [];
  const records: ScheduledTaskRecord[] = [];
  let after =
    input.window.start -
    1 -
    loopScheduleJitterMaxMs({
      config: input.config,
      jobKind: input.jobKind,
      ...(input.scheduleJitterMinutes !== undefined
        ? { scheduleJitterMinutes: input.scheduleJitterMinutes }
        : {}),
    });
  for (;;) {
    const scheduledAt = nextFire({ kind: "cron", cron: input.schedule }, after);
    if (scheduledAt === null || scheduledAt >= input.window.end || scheduledAt > input.now) break;
    const jitterMs = loopScheduleJitterMs({
      config: input.config,
      jobKey: input.jobKey,
      jobKind: input.jobKind,
      scheduledAt,
      ...(input.scheduleJitterMinutes !== undefined
        ? { scheduleJitterMinutes: input.scheduleJitterMinutes }
        : {}),
    });
    const effectiveAt = scheduledAt + jitterMs;
    if (
      effectiveAt < input.window.start ||
      effectiveAt >= input.window.end ||
      effectiveAt > input.now
    ) {
      after = scheduledAt;
      continue;
    }
    const taskId = `loop:${input.jobKey}:${scheduledAt}`;
    const artifactRecord = recordForLoopRunArtifact({
      projectId: input.projectId,
      jobKind: input.jobKind,
      jobKey: input.jobKey,
      scheduledAt,
      taskId,
      now: input.now,
      ...(input.loopRunsDir !== undefined ? { loopRunsDir: input.loopRunsDir } : {}),
    });
    if (artifactRecord !== null) {
      records.push(artifactRecord);
      after = scheduledAt;
      continue;
    }
    records.push({
      taskId,
      source: "loop-engineering",
      name: `${input.projectId} ${input.jobKind}`,
      scheduledAt,
      status: "expected",
      summary: "loop-engineering schedule discovered; no explicit run record was found yet",
      updatedAt: input.now,
    });
    after = scheduledAt;
  }
  return records;
}

function recordForLoopRunArtifact(input: {
  projectId: string;
  jobKey: string;
  jobKind: LoopDiscoveredJobKind;
  scheduledAt: number;
  taskId: string;
  now: number;
  loopRunsDir?: string;
}): ScheduledTaskRecord | null {
  const runId = loopRunId(input.scheduledAt, input.projectId, input.jobKind, input.jobKey);
  const runDir = join(input.loopRunsDir ?? loopRunsRoot(), input.projectId, runId);
  const latestSuccess = latestSuccessfulLoopRunAfter({
    projectId: input.projectId,
    jobKey: input.jobKey,
    jobKind: input.jobKind,
    scheduledAt: input.scheduledAt,
    now: input.now,
    ...(input.loopRunsDir !== undefined ? { loopRunsDir: input.loopRunsDir } : {}),
  });
  const artifactRecord = recordForSupervisorArtifacts({
    ...input,
    runDir,
  });
  if (artifactRecord !== null) {
    return withLaterSuccessResolution(artifactRecord, latestSuccess);
  }

  return null;
}

function recordForSupervisorArtifacts(input: {
  projectId: string;
  jobKind: LoopDiscoveredJobKind;
  scheduledAt: number;
  taskId: string;
  now: number;
  runDir: string;
  finalSummaryPath?: string;
}): ScheduledTaskRecord | null {
  const systemGatePath = join(input.runDir, LOOP_RUN_ARTIFACTS.systemGate);
  const systemGate = readJsonRecord(systemGatePath);
  if (systemGate?.accepted === false) {
    return recordForSystemGateFailure({
      ...input,
      path: systemGatePath,
      gate: systemGate,
    });
  }
  const finalSummaryPath =
    input.finalSummaryPath ?? join(input.runDir, LOOP_RUN_ARTIFACTS.supervisorFinalSummary);
  const finalSummary = readJsonRecord(finalSummaryPath);
  const supervisorSummaryPath = join(input.runDir, LOOP_RUN_ARTIFACTS.supervisorSummary);
  const supervisorSummary = readJsonRecord(supervisorSummaryPath);
  if (
    finalSummary !== null &&
    supervisorSummary !== null &&
    shouldPreferSupervisorSummaryOverFinalSummary(supervisorSummary)
  ) {
    return recordForSupervisorSummary({
      ...input,
      path: supervisorSummaryPath,
      summary: supervisorSummary,
    });
  }
  if (finalSummary !== null) {
    return recordForSupervisorFinalSummary({
      ...input,
      path: finalSummaryPath,
      summary: finalSummary,
    });
  }
  if (supervisorSummary !== null) {
    return recordForSupervisorSummary({
      ...input,
      path: supervisorSummaryPath,
      summary: supervisorSummary,
    });
  }
  return null;
}

function recordForSystemGateFailure(input: {
  projectId: string;
  jobKind: LoopDiscoveredJobKind;
  scheduledAt: number;
  taskId: string;
  now: number;
  path: string;
  gate: Record<string, unknown>;
}): ScheduledTaskRecord {
  const failures = Array.isArray(input.gate.failures)
    ? input.gate.failures.filter((failure): failure is string => typeof failure === "string")
    : [];
  const evalSummary = systemGateEvalOutcomeSummary(input.gate);
  return {
    taskId: input.taskId,
    source: "loop-engineering",
    name: `${input.projectId} ${input.jobKind}`,
    scheduledAt: input.scheduledAt,
    status: "failed",
    error:
      failures.length === 0
        ? "supervised system gate rejected the run"
        : `supervised system gate failed: ${failures.join("; ")}`,
    summary: ["System gate rejected a completed supervisor run.", evalSummary]
      .filter((part): part is string => typeof part === "string")
      .join(" "),
    reportPath: input.path,
    repairStatus: "pending",
    updatedAt: input.now,
  };
}

function systemGateEvalOutcomeSummary(gate: Record<string, unknown>): string | null {
  const evalReport = gate.evalReport;
  if (!isRecord(evalReport)) return null;
  const outcome = evalReport.outcome;
  if (!isRecord(outcome)) return null;
  const status = typeof outcome.status === "string" ? outcome.status : null;
  if (status === null) return null;
  const reason = typeof outcome.reason === "string" ? ` reason=${outcome.reason}` : "";
  return `eval=${status}${reason}`;
}

function shouldPreferSupervisorSummaryOverFinalSummary(summary: Record<string, unknown>): boolean {
  const status = typeof summary.status === "string" ? summary.status : "unknown";
  return status !== "completed" && status !== "invalid-output";
}

function latestSuccessfulLoopRunAfter(input: {
  projectId: string;
  jobKey: string;
  jobKind: LoopDiscoveredJobKind;
  scheduledAt: number;
  now: number;
  loopRunsDir?: string;
}): { scheduledAt: number; path: string } | null {
  const root = join(input.loopRunsDir ?? loopRunsRoot(), input.projectId);
  if (!existsSync(root)) return null;
  let latest: { scheduledAt: number; path: string } | null = null;
  for (const name of readdirSync(root)) {
    const match = loopRunDirMatch(name, input.projectId, input.jobKind, input.jobKey);
    if (match === null || match.scheduledAt <= input.scheduledAt || match.scheduledAt > input.now) {
      continue;
    }
    const finalSummaryPath = join(root, name, LOOP_RUN_ARTIFACTS.supervisorFinalSummary);
    const finalSummary = readJsonRecord(finalSummaryPath);
    if (finalSummary?.status !== "completed") continue;
    if (latest === null || match.scheduledAt > latest.scheduledAt) {
      latest = { scheduledAt: match.scheduledAt, path: finalSummaryPath };
    }
  }
  return latest;
}

function loopRunDirMatch(
  name: string,
  projectId: string,
  jobKind: LoopDiscoveredJobKind,
  jobKey: string,
): { scheduledAt: number } | null {
  const suffix = loopRunSuffix(projectId, jobKind, jobKey);
  if (!name.endsWith(suffix)) return null;
  const raw = name.slice(0, -suffix.length);
  if (!/^\d+$/.test(raw)) return null;
  return { scheduledAt: Number(raw) };
}

function loopRunId(
  scheduledAt: number,
  projectId: string,
  jobKind: LoopDiscoveredJobKind,
  jobKey: string,
): string {
  return `${scheduledAt}${loopRunSuffix(projectId, jobKind, jobKey)}`;
}

function loopRunSuffix(projectId: string, jobKind: LoopDiscoveredJobKind, jobKey: string): string {
  const workspaceJob = jobKey.startsWith("workspace:");
  if (jobKind === "architecture") return `-${projectId}`;
  if (jobKind === "workspace-architecture") return `-${projectId}-workspace`;
  if (workspaceJob && jobKind === "bug-fix") return `-${projectId}-workspace-bug-fix`;
  if (workspaceJob && jobKind === "test-coverage") return `-${projectId}-workspace-test-coverage`;
  if (workspaceJob && jobKind === "security-maintenance")
    return `-${projectId}-workspace-security-maintenance`;
  if (workspaceJob && jobKind === "harness-auto") return `-${projectId}-workspace-harness-auto`;
  if (workspaceJob && jobKind === "opportunity-discovery")
    return `-${projectId}-workspace-opportunity-discovery`;
  if (workspaceJob && jobKind === "pull-request-review") return `-${projectId}-workspace-pr-review`;
  if (jobKind === "bug-fix") return `-${projectId}-bug-fix`;
  if (jobKind === "test-coverage") return `-${projectId}-test-coverage`;
  if (jobKind === "security-maintenance") return `-${projectId}-security-maintenance`;
  if (jobKind === "harness-auto") return `-${projectId}-harness-auto`;
  if (jobKind === "automation-governance-review")
    return `-${projectId}-automation-governance-review`;
  if (jobKind === "repository-pull-request-review") return `-${projectId}-repo-pr-review`;
  return `-${projectId}-pr-review`;
}

function withLaterSuccessResolution(
  record: ScheduledTaskRecord,
  laterSuccess: { scheduledAt: number; path: string } | null,
): ScheduledTaskRecord {
  if (
    laterSuccess === null ||
    (record.status !== "failed" &&
      record.status !== "running-timeout" &&
      record.status !== "missing")
  ) {
    return record;
  }
  return {
    ...record,
    repairStatus: "fixed",
    summary: [
      record.summary,
      `Superseded by later successful loop run at ${new Date(laterSuccess.scheduledAt).toISOString()}.`,
    ]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" "),
    reportPath: record.reportPath ?? laterSuccess.path,
  };
}

function recordForSupervisorFinalSummary(input: {
  projectId: string;
  jobKind: LoopDiscoveredJobKind;
  scheduledAt: number;
  taskId: string;
  now: number;
  path: string;
  summary: Record<string, unknown>;
}): ScheduledTaskRecord {
  const status = typeof input.summary.status === "string" ? input.summary.status : "unknown";
  const summaryText =
    parseFirstString(input.summary.actionsTaken) ?? `final summary status ${status}`;
  if (status === "completed") {
    const anomaly = completedFinalSummaryAnomaly(input.summary);
    if (anomaly !== null) {
      return {
        taskId: input.taskId,
        source: "loop-engineering",
        name: `${input.projectId} ${input.jobKind}`,
        scheduledAt: input.scheduledAt,
        status: "failed",
        error: anomaly,
        summary: summaryText,
        reportPath: input.path,
        repairStatus: "pending",
        updatedAt: input.now,
      };
    }
    return {
      taskId: input.taskId,
      source: "loop-engineering",
      name: `${input.projectId} ${input.jobKind}`,
      scheduledAt: input.scheduledAt,
      status: "success",
      summary: summaryText,
      reportPath: input.path,
      repairStatus: "not-needed",
      updatedAt: input.now,
    };
  }
  return {
    taskId: input.taskId,
    source: "loop-engineering",
    name: `${input.projectId} ${input.jobKind}`,
    scheduledAt: input.scheduledAt,
    status: "failed",
    error: `loop supervisor final status ${status}`,
    summary: summaryText,
    reportPath: input.path,
    repairStatus: status === "blocked" ? "blocked" : "pending",
    updatedAt: input.now,
  };
}

function completedFinalSummaryAnomaly(summary: Record<string, unknown>): string | null {
  const finalVerification = summary.finalVerification;
  if (typeof finalVerification === "string" && finalVerification.trim() !== "passed") {
    return `loop supervisor completed with finalVerification=${finalVerification.trim() || "empty"}`;
  }
  const followUps = Array.isArray(summary.followUps)
    ? summary.followUps.filter((item): item is string => typeof item === "string")
    : [];
  const riskyFollowUp = followUps.find(isRiskyFollowUp);
  return riskyFollowUp === undefined
    ? null
    : `loop supervisor completed with unresolved risky follow-up: ${riskyFollowUp}`;
}

function isRiskyFollowUp(value: string): boolean {
  return /\b(blocked|failed|failure|error|dirty|permission|unauthorized|forbidden|timeout|timed out|ci|merge conflict|conflicted|not verified|verification failed|not clean|manual intervention)\b/i.test(
    value,
  );
}

function recordForSupervisorSummary(input: {
  projectId: string;
  jobKind: LoopDiscoveredJobKind;
  scheduledAt: number;
  taskId: string;
  now: number;
  runDir: string;
  path: string;
  summary: Record<string, unknown>;
}): ScheduledTaskRecord {
  const status = typeof input.summary.status === "string" ? input.summary.status : "unknown";
  const result = isRecord(input.summary.result) ? input.summary.result : null;
  const reason = typeof result?.reason === "string" ? result.reason : undefined;
  const timestamps = isRecord(input.summary.timestamps) ? input.summary.timestamps : null;
  const endedAt = typeof timestamps?.endedAt === "number" ? timestamps.endedAt : undefined;
  const reportPath = existsSync(join(input.runDir, LOOP_RUN_ARTIFACTS.supervisorMarkdown))
    ? join(input.runDir, LOOP_RUN_ARTIFACTS.supervisorMarkdown)
    : input.path;
  const detail = reason === undefined ? status : `${status}: ${reason}`;
  if (status === "completed") {
    return {
      taskId: input.taskId,
      source: "loop-engineering",
      name: `${input.projectId} ${input.jobKind}`,
      scheduledAt: input.scheduledAt,
      status: "success",
      ...(endedAt !== undefined ? { endedAt } : {}),
      summary: "Loop supervisor run completed.",
      reportPath,
      repairStatus: "not-needed",
      updatedAt: input.now,
    };
  }
  return {
    taskId: input.taskId,
    source: "loop-engineering",
    name: `${input.projectId} ${input.jobKind}`,
    scheduledAt: input.scheduledAt,
    status: "failed",
    ...(endedAt !== undefined ? { endedAt } : {}),
    error: `loop supervisor run ${detail}`,
    summary: "Loop supervisor run did not complete successfully.",
    reportPath,
    repairStatus: "pending",
    updatedAt: input.now,
  };
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function parseFirstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value.find((item) => typeof item === "string");
  return typeof first === "string" && first.trim().length > 0 ? first : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordForLaunchdPlist(
  plist: LaunchdPlist,
  window: TaskWindow,
  now: number,
  fileTime: (path: string) => number | null,
  launchctlState: (label: string) => string | null,
): ScheduledTaskRecord {
  const taskId = `launchd:${plist.label}:${window.label}`;
  const stderrTime = plist.stderrPath ? fileTime(plist.stderrPath) : null;
  if (
    plist.stderrPath &&
    stderrTime !== null &&
    stderrTime >= window.start &&
    stderrTime < window.end
  ) {
    return {
      taskId,
      source: "launchd",
      name: `launchd ${plist.label}`,
      scheduledAt: window.start,
      status: "failed",
      error: `stderr log changed during audited window: ${basename(plist.stderrPath)}`,
      reportPath: plist.stderrPath,
      repairStatus: "pending",
      updatedAt: now,
    };
  }
  const stdoutTime = plist.stdoutPath ? fileTime(plist.stdoutPath) : null;
  if (
    plist.stdoutPath &&
    stdoutTime !== null &&
    stdoutTime >= window.start &&
    stdoutTime < window.end
  ) {
    return {
      taskId,
      source: "launchd",
      name: `launchd ${plist.label}`,
      scheduledAt: window.start,
      status: "success",
      summary: `stdout log changed during audited window: ${basename(plist.stdoutPath)}`,
      reportPath: plist.stdoutPath,
      repairStatus: "not-needed",
      updatedAt: now,
    };
  }
  const exitCode = parseLastExitCode(launchctlState(plist.label));
  if (exitCode === 0) {
    return {
      taskId,
      source: "launchd",
      name: `launchd ${plist.label}`,
      scheduledAt: window.start,
      status: "success",
      summary: "launchctl last exit code 0",
      repairStatus: "not-needed",
      updatedAt: now,
    };
  }
  if (exitCode !== null) {
    return {
      taskId,
      source: "launchd",
      name: `launchd ${plist.label}`,
      scheduledAt: window.start,
      status: "failed",
      error: `launchctl last exit code ${exitCode}`,
      repairStatus: "pending",
      updatedAt: now,
    };
  }
  return {
    taskId,
    source: "launchd",
    name: `launchd ${plist.label}`,
    scheduledAt: window.start,
    status: "expected",
    summary: "launchd scheduled task discovered; no explicit task report was recorded",
    updatedAt: now,
  };
}

function defaultFileTime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function defaultLaunchctlState(label: string): string | null {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    return execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function parseLastExitCode(text: string | null): number | null {
  const match = /last exit code = (-?\d+)/.exec(text ?? "");
  if (!match?.[1]) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : null;
}

function parseLaunchdPlist(path: string): LaunchdPlist | null {
  try {
    const xml = readFileSync(path, "utf8");
    const label = stringValue(xml, "Label");
    if (!label) return null;
    const stdoutPath = stringValue(xml, "StandardOutPath");
    const stderrPath = stringValue(xml, "StandardErrorPath");
    return {
      label,
      scheduled: hasKey(xml, "StartInterval") || hasKey(xml, "StartCalendarInterval"),
      ...(stdoutPath ? { stdoutPath } : {}),
      ...(stderrPath ? { stderrPath } : {}),
    };
  } catch {
    return null;
  }
}

function hasKey(xml: string, key: string): boolean {
  return new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>`).test(xml);
}

function stringValue(xml: string, key: string): string | null {
  const match = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([^<]*)</string>`,
  ).exec(xml);
  return match?.[1]?.trim() || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
