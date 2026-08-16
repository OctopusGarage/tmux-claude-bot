import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLoopSupervisorWorkOrderRegistry } from "../loop/supervisor-state.js";
import {
  type ConfiguredRecoveryConfig,
  type ConfiguredRecoveryTarget,
  classifyHistoricalFailure,
  type HistoricalRecoveryInput,
  type RecoveryClassification,
  resolveConfiguredRecoveryTarget,
} from "./project-recovery.js";
import type { RepairCoordinator } from "./repair-coordinator.js";
import type { ScheduledTaskRecord, ScheduledTaskRepairStatus } from "./task-ledger.js";

type RecoveryRecord = ScheduledTaskRecord & { repairStatus: "pending" | "blocked" };

export type ProjectRecoveryDispatchRequest = {
  target: ConfiguredRecoveryTarget;
  taskFamily: string;
  taskIds: string[];
  classification: { classification: RecoveryClassification; reason: string };
  evidence: string[];
};

export type ProjectRecoveryDispatch = (
  request: ProjectRecoveryDispatchRequest,
) => Promise<{ status: "queued"; runId: string } | { status: "blocked"; detail: string }>;

export type ProjectRecoveryPassResult = {
  classified: number;
  enqueued: number;
  dispatched: number;
  waitingExternal: number;
  ownerDecision: number;
  superseded: number;
  unconfigured: number;
  deadLetter: number;
  deferred: number;
};

export type ProjectRecoveryArtifactReconciliationResult = {
  checked: number;
  fixed: number;
  blocked: number;
};

export async function runProjectRecoveryPass(input: {
  now: number;
  records: readonly RecoveryRecord[];
  config: ConfiguredRecoveryConfig;
  coordinator: RepairCoordinator;
  updateRepairStatus: (
    taskId: string,
    repairStatus: ScheduledTaskRepairStatus,
    summary: string,
  ) => void;
  dispatch?: ProjectRecoveryDispatch;
  canonicalize: (path: string) => string;
  verifyProjectPath?: (path: string) => boolean;
}): Promise<ProjectRecoveryPassResult> {
  const result: ProjectRecoveryPassResult = {
    classified: 0,
    enqueued: 0,
    dispatched: 0,
    waitingExternal: 0,
    ownerDecision: 0,
    superseded: 0,
    unconfigured: 0,
    deadLetter: 0,
    deferred: 0,
  };
  const targetById = new Map<string, ConfiguredRecoveryTarget>();
  const recordsByTarget = new Map<string, RecoveryRecord[]>();
  const workOrderRegistry = readLoopSupervisorWorkOrderRegistry(input.now);
  const reservedWorkOrders = [
    ...workOrderRegistry.unfinished,
    ...workOrderRegistry.recoverableFinalSummary,
  ];
  const terminalWorkOrders = workOrderRegistry.terminal;

  for (const record of input.records) {
    if (record.source !== "loop-engineering" && record.source !== "autopilot-delegate") continue;
    const artifactText =
      record.reportPath === undefined ? undefined : readRecoveryArtifact(record.reportPath);
    const recoveryInput: HistoricalRecoveryInput = {
      taskId: record.taskId,
      source: record.source,
      name: record.name,
      status: record.status,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
      ...(record.summary === undefined ? {} : { summary: record.summary }),
      ...(record.reportPath === undefined ? {} : { reportPath: record.reportPath }),
      ...(artifactText === undefined ? {} : { artifactText }),
      attempt:
        input.coordinator.list().find((queued) => queued.linkedTaskIds.includes(record.taskId))
          ?.attempt ?? 0,
    };
    const classification = classifyHistoricalFailure(recoveryInput);
    result.classified++;
    if (classification.classification === "superseded") {
      input.updateRepairStatus(record.taskId, "superseded", classification.reason);
      result.superseded++;
      continue;
    }
    const target = resolveConfiguredRecoveryTarget(input.config, recoveryInput, input.canonicalize);
    if (target === null || input.verifyProjectPath?.(target.path) === false) {
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        `Recovery classification: needs-owner-decision; configured project is unavailable or ambiguous. ${classification.reason}`,
      );
      result.unconfigured++;
      continue;
    }
    if (classification.classification === "waiting-external") {
      if (record.repairStatus === "blocked") {
        input.updateRepairStatus(
          record.taskId,
          "pending",
          `Recovery classification: waiting-external; ${classification.reason}`,
        );
      }
      result.waitingExternal++;
      continue;
    }
    if (classification.classification === "dead-letter") {
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        `Recovery classification: ${classification.reason}`,
      );
      result.deadLetter++;
      continue;
    }
    if (classification.classification !== "retryable") {
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        `Recovery classification: ${classification.classification}; ${classification.reason}`,
      );
      result.ownerDecision++;
      continue;
    }
    const targetRecords = recordsByTarget.get(target.id) ?? [];
    targetRecords.push(record);
    recordsByTarget.set(target.id, targetRecords);
    targetById.set(target.id, target);
  }

  for (const [targetId, records] of recordsByTarget) {
    const target = targetById.get(targetId);
    if (target === undefined) continue;
    let existing = input.coordinator.findOpenProjectRecovery(target.id);
    const hasReservedWorkOrder = reservedWorkOrders.some(
      (record) =>
        input.canonicalize(record.workOrder.projectPath) === input.canonicalize(target.path),
    );
    if (existing !== undefined && hasReservedWorkOrder) {
      input.coordinator.linkTaskIds(
        existing.id,
        records.map((record) => record.taskId),
        input.now,
      );
      for (const record of records) {
        input.updateRepairStatus(
          record.taskId,
          "pending",
          `Recovery dispatch deferred: project already has an active WorkOrder (${existing.id}).`,
        );
      }
      result.deferred++;
      continue;
    }
    if (existing !== undefined && (existing.status === "leased" || existing.status === "running")) {
      const hasTerminalLinkedWorkOrder = existing.linkedTaskIds.some((taskId) =>
        terminalWorkOrders.some(
          (record) =>
            taskId === `autopilot:${record.workOrder.id}` ||
            taskId.endsWith(`:${record.workOrder.id}`),
        ),
      );
      if (!hasReservedWorkOrder && hasTerminalLinkedWorkOrder) {
        const existingId = existing.id;
        input.coordinator.releaseToQueue(existingId, input.now);
        existing = input.coordinator.list().find((record) => record.id === existingId);
      } else {
        input.coordinator.linkTaskIds(
          existing.id,
          records.map((record) => record.taskId),
          input.now,
        );
        for (const record of records) {
          input.updateRepairStatus(
            record.taskId,
            "pending",
            `Recovery dispatch deferred: project already has an active recovery (${existing.id}).`,
          );
        }
        result.deferred++;
        continue;
      }
    }
    const queueRecord =
      existing ??
      input.coordinator.enqueue({
        projectId: target.id,
        projectPath: target.path,
        source: "project-recovery",
        taskFamily: records[0]?.name ?? target.id,
        fingerprint: records
          .map((record) => record.failureKind ?? record.error ?? record.summary ?? "unknown")
          .join(" | "),
        taskId: records[0]?.taskId ?? target.id,
        ...(records[0]?.summary === undefined ? {} : { summary: records[0].summary }),
        priority: 100,
        now: input.now,
      });
    if (existing === undefined) result.enqueued++;
    else
      input.coordinator.linkTaskIds(
        existing.id,
        records.map((record) => record.taskId),
        input.now,
      );
    if (input.dispatch === undefined) continue;
    const leaseId = `project-recovery:${input.now}:${target.id}`;
    const claimed = input.coordinator.claimIds([queueRecord.id], {
      now: input.now,
      leaseId,
      limit: 1,
    });
    if (claimed.length === 0) continue;
    const evidence = records.flatMap((record) =>
      [record.error, record.failureKind, record.summary].filter(
        (value): value is string => value !== undefined,
      ),
    );
    const classification = classifyHistoricalFailure({
      taskId: records[0]?.taskId ?? target.id,
      source: records[0]?.source ?? "loop-engineering",
      name: records[0]?.name ?? target.id,
      status: "failed",
      summary: evidence.join(" "),
      artifactText: evidence.join(" "),
      attempt: 0,
    });
    const dispatched = await input.dispatch({
      target,
      taskFamily: records[0]?.name ?? target.id,
      taskIds: records.map((record) => record.taskId),
      classification,
      evidence,
    });
    if (dispatched.status === "blocked") {
      input.coordinator.releaseToQueue(queueRecord.id, input.now);
      for (const record of records) {
        input.updateRepairStatus(
          record.taskId,
          "pending",
          `Recovery dispatch deferred: ${dispatched.detail}`,
        );
      }
      continue;
    }
    input.coordinator.linkTaskIds(queueRecord.id, [`autopilot:${dispatched.runId}`], input.now);
    input.coordinator.markRunning(queueRecord.id, leaseId, input.now);
    for (const record of records) {
      input.updateRepairStatus(
        record.taskId,
        "running",
        `Project recovery delegated run ${dispatched.runId}.`,
      );
    }
    result.dispatched++;
  }
  return result;
}

export async function reconcileProjectRecoveryArtifacts(input: {
  now: number;
  records: readonly ScheduledTaskRecord[];
  coordinator: RepairCoordinator;
  updateRepairStatus: (
    taskId: string,
    repairStatus: ScheduledTaskRepairStatus,
    summary: string,
  ) => void;
}): Promise<ProjectRecoveryArtifactReconciliationResult> {
  const result: ProjectRecoveryArtifactReconciliationResult = { checked: 0, fixed: 0, blocked: 0 };
  const byTaskId = new Map(input.records.map((record) => [record.taskId, record]));
  for (const queueRecord of input.coordinator.list()) {
    if (queueRecord.source !== "project-recovery" || isRepairTerminal(queueRecord.status)) continue;
    const linked = queueRecord.linkedTaskIds
      .map((taskId) => byTaskId.get(taskId))
      .filter((record): record is ScheduledTaskRecord => record !== undefined);
    const originals = linked.filter(
      (record) =>
        record.status !== "success" &&
        ["failed", "missing", "running-timeout"].includes(record.status) &&
        (record.repairStatus === "pending" ||
          record.repairStatus === "running" ||
          record.repairStatus === "blocked"),
    );
    const linkedRecoverySucceeded = linked.some(
      (record) =>
        record.source === "autopilot-delegate" &&
        record.taskId !== queueRecord.linkedTaskIds[0] &&
        record.status === "success",
    );
    const summaryMatchedRecoverySucceeded = input.records.some(
      (record) =>
        record.source === "autopilot-delegate" &&
        record.status === "success" &&
        record.summary !== undefined &&
        originals.some((original) => record.summary?.includes(original.taskId)),
    );
    const recoverySucceeded = linkedRecoverySucceeded || summaryMatchedRecoverySucceeded;
    const recoveryFailed = linked.some(
      (record) =>
        record.source === "autopilot-delegate" &&
        record.taskId !== queueRecord.linkedTaskIds[0] &&
        ["failed", "missing", "running-timeout"].includes(record.status),
    );
    if (!recoverySucceeded && (!recoveryFailed || originals.length === 0)) continue;
    result.checked++;
    if (recoverySucceeded) {
      for (const original of originals) {
        input.updateRepairStatus(
          original.taskId,
          "fixed",
          "Closed from the authoritative successful project recovery delegation.",
        );
      }
      input.coordinator.markTerminal(queueRecord.id, "fixed", input.now);
      result.fixed++;
      continue;
    }
    if (recoveryFailed) {
      for (const recovery of linked.filter(
        (record) =>
          record.source === "autopilot-delegate" &&
          record.taskId !== queueRecord.linkedTaskIds[0] &&
          ["failed", "missing", "running-timeout"].includes(record.status) &&
          (record.repairStatus === "pending" || record.repairStatus === "running"),
      )) {
        input.updateRepairStatus(
          recovery.taskId,
          "pending",
          "Delegated recovery ended without a terminal success; returned to the repair queue.",
        );
      }
      for (const original of originals) {
        input.updateRepairStatus(
          original.taskId,
          "pending",
          "Delegated recovery failed; returned to the repair queue for another worker.",
        );
      }
      input.coordinator.releaseToQueue(queueRecord.id, input.now);
    }
  }
  for (const record of input.records) {
    if (
      (record.source !== "loop-engineering" && record.source !== "autopilot-delegate") ||
      !["failed", "missing", "running-timeout"].includes(record.status) ||
      (record.repairStatus !== "pending" && record.repairStatus !== "running") ||
      record.reportPath === undefined
    )
      continue;
    const summaryPath = readFinalSummaryPath(record.reportPath);
    if (summaryPath === undefined) continue;
    const summary = readJson(summaryPath);
    if (summary === undefined) continue;
    result.checked++;
    const queueRecord = input.coordinator
      .list()
      .find((queued) => queued.linkedTaskIds.includes(record.taskId));
    const reviewGate = summary.reviewGate;
    const passed =
      summary.status === "completed" &&
      summary.finalVerification === "passed" &&
      reviewGate !== null &&
      typeof reviewGate === "object" &&
      (reviewGate as Record<string, unknown>).decision === "pass";
    if (passed) {
      input.updateRepairStatus(
        record.taskId,
        "fixed",
        "Closed from the authoritative supervisor final summary; recovery completed and verification passed.",
      );
      if (queueRecord !== undefined)
        input.coordinator.markTerminal(queueRecord.id, "fixed", input.now);
      result.fixed++;
      continue;
    }
    input.updateRepairStatus(
      record.taskId,
      "blocked",
      `Authoritative supervisor final summary reports blocked recovery (status=${String(summary.status ?? "unknown")}).`,
    );
    if (queueRecord !== undefined)
      input.coordinator.markTerminal(queueRecord.id, "blocked", input.now);
    result.blocked++;
  }
  return result;
}

function isRepairTerminal(status: string): boolean {
  return ["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(status);
}

function readFinalSummaryPath(reportPath: string): string | undefined {
  try {
    const candidate = reportPath.endsWith("supervisor-final-summary.json")
      ? reportPath
      : join(
          reportPath.endsWith(".md") ? dirname(reportPath) : reportPath,
          "supervisor-final-summary.json",
        );
    readFileSync(candidate, "utf8");
    return candidate;
  } catch {
    return undefined;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readRecoveryArtifact(reportPath: string): string | undefined {
  const basePath =
    reportPath.endsWith(".md") || reportPath.endsWith(".json") ? dirname(reportPath) : reportPath;
  const paths = [
    join(basePath, "work-order.json"),
    reportPath,
    join(basePath, "supervisor-final-summary.json"),
    join(basePath, "supervisor-summary.json"),
    join(basePath, "system-gate.json"),
  ];
  const seen = new Set<string>();
  const evidence = paths
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .flatMap((path) => {
      try {
        return [readFileSync(path, "utf8")];
      } catch {
        return [];
      }
    });
  return evidence.length === 0 ? undefined : evidence.join("\n").slice(0, 32_000);
}
