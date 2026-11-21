import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseSupervisorReviewGate } from "../loop/final-summary-contract.js";
import {
  readLoopSupervisorWorkOrderRegistry,
  type UnfinishedLoopSupervisorWorkOrder,
} from "../loop/supervisor-state.js";
import {
  type ConfiguredRecoveryConfig,
  type ConfiguredRecoveryTarget,
  classifyHistoricalFailure,
  extractExplicitTargetIds,
  type HistoricalRecoveryInput,
  hasGenericProjectRecoveryClosure,
  hasOriginalRecoveryRetryEvidence,
  hasUnsafeRecoveryEvidence,
  isRetryableSourceGitStateEvidence,
  type RecoveryClassification,
  resolveConfiguredRecoveryTarget,
} from "./project-recovery.js";
import { REPAIR_MAX_ATTEMPTS, type RepairCoordinator } from "./repair-coordinator.js";
import type { ScheduledTaskRecord, ScheduledTaskRepairStatus } from "./task-ledger.js";

type RecoveryRecord = ScheduledTaskRecord & { repairStatus: "pending" | "blocked" };

const ADMISSION_RECHECK_MS = 15 * 60_000;

export type ProjectRecoveryDispatchRequest = {
  target: ConfiguredRecoveryTarget;
  taskFamily: string;
  taskIds: string[];
  classification: { classification: RecoveryClassification; reason: string };
  evidence: string[];
};

export type ProjectRecoveryDispatch = (
  request: ProjectRecoveryDispatchRequest,
) => Promise<
  { status: "queued"; runId: string } | { status: "blocked"; detail: string; retryAt?: number }
>;

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
  const reservedWorkOrders = dedupeWorkOrdersByRunDir([
    ...workOrderRegistry.unfinished,
    ...workOrderRegistry.recoverableFinalSummary,
    ...workOrderRegistry.recoverableFailed,
  ]);
  const terminalWorkOrders = workOrderRegistry.terminal;
  const terminalClosureRunIds = terminalProjectRecoveryRunIds(input.coordinator);

  for (const record of input.records) {
    if (record.source !== "loop-engineering" && record.source !== "autopilot-delegate") continue;
    if (
      originalHasAuthoritativeRecoveryBoundary(
        record,
        input.coordinator,
        input.records,
        workOrderRegistry.records,
      )
    ) {
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        "Recovery classification: waiting-external; latest authoritative external or uncertain-execution artifact prohibits automatic replay.",
      );
      result.waitingExternal++;
      continue;
    }
    if (isCoveredByTerminalProjectRecovery(record, terminalClosureRunIds)) {
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      );
      continue;
    }
    const artifact =
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
      ...artifact,
      attempt:
        input.coordinator.list().find((queued) => queued.linkedTaskIds.includes(record.taskId))
          ?.attempt ?? 0,
    };
    const originalAttempt = Math.max(
      0,
      ...input.coordinator
        .list()
        .filter((queued) => queued.linkedTaskIds.includes(record.taskId))
        .map((queued) => queued.attempt),
    );
    recoveryInput.attempt = originalAttempt;
    const classification =
      hasOriginalRecoveryRetryEvidence(record, artifact?.artifactText) &&
      originalAttempt >= REPAIR_MAX_ATTEMPTS
        ? {
            classification: "dead-letter" as const,
            reason: "original recovery attempt limit reached; preserved retry budget",
          }
        : classifyHistoricalFailure(recoveryInput);
    result.classified++;
    if (classification.classification === "superseded") {
      input.updateRepairStatus(record.taskId, "superseded", classification.reason);
      result.superseded++;
      continue;
    }
    const target = resolveConfiguredRecoveryTarget(input.config, recoveryInput, input.canonicalize);
    if (
      target === null ||
      (target.kind === "workspace"
        ? !target.repositoryPaths?.length ||
          target.repositoryPaths.some((path) => input.verifyProjectPath?.(path) === false)
        : input.verifyProjectPath?.(target.path) === false)
    ) {
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        `Recovery classification: needs-owner-decision; configured project is unavailable or ambiguous. ${classification.reason}`,
      );
      result.unconfigured++;
      continue;
    }
    if (classification.classification === "waiting-external") {
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        `Recovery classification: waiting-external; ${classification.reason}`,
      );
      closeLinkedProjectRecoveryQueues(input.coordinator, record.taskId, input.now);
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
    const groupId = `${target.id}:${originalAttempt}`;
    const targetRecords = recordsByTarget.get(groupId) ?? [];
    targetRecords.push(record);
    recordsByTarget.set(groupId, targetRecords);
    targetById.set(groupId, target);
  }

  for (const [targetId, records] of recordsByTarget) {
    const target = targetById.get(targetId);
    if (target === undefined) continue;
    let existing = input.coordinator.findOpenProjectRecovery(target.id);
    const originalAttempt = Math.max(
      0,
      ...input.coordinator
        .list()
        .filter((queued) => records.some((record) => queued.linkedTaskIds.includes(record.taskId)))
        .map((queued) => queued.attempt),
    );
    if (
      existing !== undefined &&
      (existing.status === "pending" || existing.status === "retry-wait") &&
      existing.attempt < originalAttempt &&
      records.every((record) => existing?.linkedTaskIds.includes(record.taskId))
    ) {
      existing = input.coordinator.enqueue({
        projectId: existing.projectId,
        projectPath: existing.projectPath,
        source: "project-recovery",
        taskFamily: existing.taskFamily,
        fingerprint: existing.fingerprint,
        taskId: records[0]?.taskId ?? target.id,
        originalAttempt,
        now: input.now,
      });
    }
    if (existing !== undefined && existing.attempt !== originalAttempt) {
      for (const record of records)
        input.updateRepairStatus(
          record.taskId,
          "pending",
          "Recovery dispatch deferred: another original retry budget owns this project's recovery; preserved separate attempt budget.",
        );
      result.deferred++;
      continue;
    }
    const hasReservedWorkOrder = reservedWorkOrders.some(
      (record) =>
        input.canonicalize(record.workOrder.projectPath) === input.canonicalize(target.path),
    );
    if (existing === undefined && hasReservedWorkOrder) {
      for (const record of records)
        input.updateRepairStatus(
          record.taskId,
          "pending",
          "Recovery dispatch deferred: project already has an active WorkOrder; original execution ownership is preserved.",
        );
      result.deferred++;
      continue;
    }
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
        fingerprint: projectRecoveryFingerprint(records),
        taskId: records[0]?.taskId ?? target.id,
        ...(records[0]?.summary === undefined ? {} : { summary: records[0].summary }),
        priority: 100,
        originalAttempt,
        now: input.now,
      });
    if (existing === undefined) result.enqueued++;
    input.coordinator.linkTaskIds(
      queueRecord.id,
      records.map((record) => record.taskId),
      input.now,
    );
    if (input.dispatch === undefined) continue;
    // Legacy admission stored quota reset times without a bounded recheck. A
    // never-dispatched pending record can safely re-enter the normal gates;
    // execution retries and records carrying ownership must keep their clocks.
    if (
      queueRecord.status === "pending" &&
      queueRecord.attempt === 0 &&
      queueRecord.workOrderId === undefined &&
      queueRecord.leaseId === undefined &&
      queueRecord.leaseExpiresAt === undefined &&
      queueRecord.nextAttemptAt > input.now + ADMISSION_RECHECK_MS
    ) {
      input.coordinator.releaseToQueue(queueRecord.id, input.now);
    }
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
      status: records[0]?.status ?? "failed",
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
      input.coordinator.releaseToQueue(
        queueRecord.id,
        input.now,
        Math.min(dispatched.retryAt ?? input.now, input.now + ADMISSION_RECHECK_MS),
      );
      for (const record of records) {
        input.updateRepairStatus(
          record.taskId,
          "pending",
          `Recovery dispatch deferred: ${dispatched.detail}`,
        );
      }
      result.deferred++;
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

function originalHasAuthoritativeRecoveryBoundary(
  original: ScheduledTaskRecord,
  coordinator: RepairCoordinator,
  records: readonly ScheduledTaskRecord[],
  workOrders: readonly {
    runDir: string;
    workOrder: { id: string; projectId: string; scheduledAt: number };
  }[],
): boolean {
  if (hasUnsafeRecoveryEvidence([original.error, original.summary].join(" "))) return true;
  const originalPaths = workOrders
    .filter(
      (entry) =>
        original.taskId === `autopilot:${entry.workOrder.id}` ||
        (original.source === "loop-engineering" &&
          original.taskId.split(":").includes(entry.workOrder.projectId) &&
          (original.taskId.endsWith(`:${entry.workOrder.scheduledAt}`) ||
            original.taskId.endsWith(`:${entry.workOrder.id}`))),
    )
    .map((entry) => entry.runDir);
  if (original.reportPath !== undefined) originalPaths.push(original.reportPath);
  if (originalPaths.some((path) => recoveryArtifactHasBoundary(path))) return true;
  const linkedIds = new Set(
    coordinator
      .list()
      .filter(
        (queued) =>
          queued.source === "project-recovery" && queued.linkedTaskIds.includes(original.taskId),
      )
      .flatMap((queued) => queued.linkedTaskIds),
  );
  const candidates = records
    .filter(
      (record) =>
        record.source === "autopilot-delegate" &&
        linkedIds.has(record.taskId) &&
        record.reportPath !== undefined,
    )
    .map((record) => ({
      path: record.reportPath as string,
      at: record.scheduledAt,
      error: record.error,
    }));
  for (const workOrder of workOrders) {
    if (linkedIds.has(`autopilot:${workOrder.workOrder.id}`))
      candidates.push({
        path: workOrder.runDir,
        at: workOrder.workOrder.scheduledAt,
        error: undefined,
      });
  }
  const latest = candidates.sort((a, b) => b.at - a.at)[0];
  if (latest === undefined) return false;
  const summaryPath = readFinalSummaryPath(latest.path);
  const gate =
    summaryPath === undefined
      ? undefined
      : readJson(join(dirname(summaryPath), "system-gate.json"));
  return (
    ((gate?.accepted === true || gate?.resultStatus !== "dispatch-failed") &&
      hasAuthoritativeRetryConflict(gate)) ||
    hasUnsafeRecoveryEvidence(
      [latest.error, readRecoveryArtifact(latest.path).artifactText].join(" "),
    )
  );
}

function recoveryArtifactHasBoundary(path: string): boolean {
  const summaryPath = readFinalSummaryPath(path);
  const gate =
    summaryPath === undefined
      ? undefined
      : readJson(join(dirname(summaryPath), "system-gate.json"));
  return (
    ((gate?.accepted === true || gate?.resultStatus !== "dispatch-failed") &&
      hasAuthoritativeRetryConflict(gate)) ||
    hasUnsafeRecoveryEvidence(readRecoveryArtifact(path).artifactText ?? "")
  );
}

function projectRecoveryFingerprint(records: readonly RecoveryRecord[]): string {
  const evidence = records
    .map((record) => fingerprintForRecoveryRecord(record))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(evidence)].join(" | ") || "unknown";
}

function fingerprintForRecoveryRecord(record: RecoveryRecord): string {
  if (record.status === "missing") return "missing-run-record";
  if (record.status === "running-timeout") return "running-timeout";
  return record.failureKind ?? record.error ?? record.summary ?? "unknown";
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
  const originalRegistry = readLoopSupervisorWorkOrderRegistry(input.now);
  const byTaskId = new Map(input.records.map((record) => [record.taskId, record]));
  const terminalClosureRunIds = terminalProjectRecoveryRunIds(input.coordinator);
  const closedTaskIds = new Set<string>();
  for (const storedQueueRecord of input.coordinator.list()) {
    let queueRecord = storedQueueRecord;
    // Self-heal closure belongs to the investigation-window-aware reconciliation.
    if (queueRecord.source === "system-self-heal") continue;
    let linked = queueRecord.linkedTaskIds
      .map((taskId) => byTaskId.get(taskId))
      .filter((record): record is ScheduledTaskRecord => record !== undefined);
    const closureTaskMap = new Map(byTaskId);
    const legacyClosure =
      isTerminalProjectRecoveryClosure(queueRecord) ||
      hasLinkedAcceptedBlockedRecoveryArtifact(queueRecord.linkedTaskIds, byTaskId);
    const latestRecovery = linked
      .filter((record) => record.source === "autopilot-delegate")
      .sort((a, b) => b.scheduledAt - a.scheduledAt)[0];
    const latestSummaryPath =
      latestRecovery?.reportPath === undefined
        ? undefined
        : readFinalSummaryPath(latestRecovery.reportPath);
    const latestGate =
      latestSummaryPath === undefined
        ? undefined
        : readJson(join(dirname(latestSummaryPath), "system-gate.json"));
    const latestArtifact =
      latestRecovery?.reportPath === undefined
        ? ""
        : (readRecoveryArtifact(latestRecovery.reportPath).artifactText ?? "");
    const authoritativeBlocker =
      hasAuthoritativeRetryConflict(latestGate) ||
      hasUnsafeRecoveryEvidence([latestRecovery?.error, latestArtifact].join(" "));
    if (
      legacyClosure &&
      (queueRecord.status === "leased" || queueRecord.status === "running") &&
      linked.some((record) => hasOriginalRecoveryRetryEvidence(record))
    ) {
      for (const record of linked) closedTaskIds.add(record.taskId);
      continue;
    }
    const retryableOriginals =
      legacyClosure && !authoritativeBlocker
        ? linked.filter(
            (record) =>
              (record.source === "loop-engineering" ||
                (record.taskId === queueRecord.linkedTaskIds[0] &&
                  !acceptedBlockedRecoveryArtifact(record.reportPath))) &&
              (record.repairStatus === "blocked" ||
                record.repairStatus === "pending" ||
                record.repairStatus === "running") &&
              hasOriginalRecoveryRetryEvidence(
                record,
                record.reportPath === undefined
                  ? ""
                  : readRecoveryArtifact(record.reportPath).artifactText,
              ) &&
              !originalHasAuthoritativeRecoveryBoundary(
                record,
                input.coordinator,
                input.records,
                originalRegistry.records,
              ),
          )
        : [];
    if (retryableOriginals.length > 0) {
      for (const original of retryableOriginals) closedTaskIds.add(original.taskId);
      if (queueRecord.status === "leased" || queueRecord.status === "running") continue;
      const retryableIds = new Set(retryableOriginals.map((record) => record.taskId));
      for (const original of retryableOriginals) {
        if (original.repairStatus === "blocked")
          input.updateRepairStatus(
            original.taskId,
            "pending",
            "Reconsidering preserved original retryable evidence; aggregate blocked closure does not prove an execution boundary.",
          );
        closureTaskMap.delete(original.taskId);
      }
      linked = linked.filter((record) => !retryableIds.has(record.taskId));
      queueRecord = {
        ...queueRecord,
        linkedTaskIds: queueRecord.linkedTaskIds.filter((id) => !retryableIds.has(id)),
      };
      if (linked.length === 0) continue;
    }
    const terminalClosure = isTerminalProjectRecoveryClosure(queueRecord);
    const hasLinkedRecoveryArtifact = linked.some(
      (record) =>
        record.source === "autopilot-delegate" && record.taskId !== queueRecord.linkedTaskIds[0],
    );
    if (isRepairTerminal(queueRecord.status) && !terminalClosure && !hasLinkedRecoveryArtifact)
      continue;
    if (queueRecord.source !== "project-recovery" && !hasLinkedRecoveryArtifact) continue;
    if (terminalClosure) {
      const summary =
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.";
      const closureRecords = linkedTerminalClosureRecords(
        queueRecord.linkedTaskIds,
        linked,
        closureTaskMap,
      );
      const needsClosure =
        !isRepairTerminal(queueRecord.status) ||
        closureRecords.some((record) => record.repairStatus !== "blocked");
      if (!needsClosure) continue;
      for (const record of closureRecords) {
        input.updateRepairStatus(record.taskId, "blocked", summary);
        closedTaskIds.add(record.taskId);
      }
      input.coordinator.markTerminal(queueRecord.id, "blocked", input.now);
      result.blocked++;
      continue;
    }
    if (linked.length > 0 && linked.every(isTerminalLinkedRepairRecord)) {
      input.coordinator.markTerminal(queueRecord.id, linkedRepairQueueStatus(linked), input.now);
      result.checked++;
      result.fixed++;
      continue;
    }
    const originalsFixedBySuccessfulCounterpart =
      linkedOriginalsFixedBySuccessfulCounterpart(linked);
    if (originalsFixedBySuccessfulCounterpart.length > 0) {
      for (const original of originalsFixedBySuccessfulCounterpart) {
        input.updateRepairStatus(
          original.taskId,
          "fixed",
          "Closed from the authoritative successful project recovery delegation.",
        );
      }
      input.coordinator.markTerminal(queueRecord.id, "fixed", input.now);
      result.checked++;
      result.fixed++;
      continue;
    }
    const linkedRecoveryArtifacts = linked.filter(
      (record) =>
        record.source === "autopilot-delegate" && record.taskId !== queueRecord.linkedTaskIds[0],
    );
    const linkedOriginals = linked.filter((record) => !linkedRecoveryArtifacts.includes(record));
    if (
      linkedOriginals.length > 0 &&
      linkedOriginals.every(isTerminalLinkedRepairRecord) &&
      linkedRecoveryArtifacts.some(
        (record) =>
          ["failed", "missing", "running-timeout"].includes(record.status) &&
          (record.repairStatus === "pending" || record.repairStatus === "running"),
      )
    ) {
      for (const recovery of linkedRecoveryArtifacts) {
        if (
          ["failed", "missing", "running-timeout"].includes(recovery.status) &&
          (recovery.repairStatus === "pending" || recovery.repairStatus === "running")
        ) {
          input.updateRepairStatus(
            recovery.taskId,
            "superseded",
            "Superseded by an authoritative terminal repair outcome for the original task.",
          );
        }
      }
      input.coordinator.markTerminal(
        queueRecord.id,
        linkedRepairQueueStatus(linkedOriginals),
        input.now,
      );
      result.checked++;
      result.fixed++;
      continue;
    }
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
    // Investigation prose may mention unresolved tasks, even across projects.
    // Only an explicitly linked recovery can settle this repair group.
    const recoverySucceeded = linkedRecoverySucceeded;
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
      const acceptedBlockedRecoveries = linked.filter(
        (record) =>
          record.source === "autopilot-delegate" &&
          record.taskId !== queueRecord.linkedTaskIds[0] &&
          ["failed", "missing", "running-timeout"].includes(record.status) &&
          acceptedBlockedRecoveryArtifact(record.reportPath),
      );
      const newestAcceptedBlockedAt = Math.max(
        ...acceptedBlockedRecoveries.map((record) => record.updatedAt),
      );
      const newerRetryableRecoveryExists = linked.some(
        (record) =>
          record.source === "autopilot-delegate" &&
          record.taskId !== queueRecord.linkedTaskIds[0] &&
          ["failed", "missing", "running-timeout"].includes(record.status) &&
          record.updatedAt > newestAcceptedBlockedAt &&
          retryableBlockedRecoveryArtifact(record.reportPath),
      );
      if (acceptedBlockedRecoveries.length > 0 && !newerRetryableRecoveryExists) {
        const summary =
          "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.";
        for (const record of linkedAcceptedBlockedClosureRecords(
          queueRecord.linkedTaskIds,
          linked,
          closureTaskMap,
        )) {
          input.updateRepairStatus(record.taskId, "blocked", summary);
          closedTaskIds.add(record.taskId);
        }
        input.coordinator.markTerminal(queueRecord.id, "blocked", input.now);
        result.blocked++;
        continue;
      }
      const retryableBlockedRecoveries = linked.filter(
        (record) =>
          record.source === "autopilot-delegate" &&
          record.taskId !== queueRecord.linkedTaskIds[0] &&
          ["failed", "missing", "running-timeout"].includes(record.status) &&
          retryableBlockedRecoveryArtifact(record.reportPath),
      );
      const terminalRecord = [...retryableBlockedRecoveries].sort(
        (a, b) => b.scheduledAt - a.scheduledAt || b.taskId.localeCompare(a.taskId),
      )[0];
      if (terminalRecord !== undefined) {
        const transitionedTaskIds = transitionRetryableArtifact({
          coordinator: input.coordinator,
          queueRecordId: queueRecord.id,
          terminalRecord,
          now: input.now,
          records: [...originals, ...retryableBlockedRecoveries],
          updateRepairStatus: input.updateRepairStatus,
          result,
        });
        for (const taskId of transitionedTaskIds) closedTaskIds.add(taskId);
        continue;
      }
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
    if (closedTaskIds.has(record.taskId)) continue;
    if (
      (record.source !== "loop-engineering" && record.source !== "autopilot-delegate") ||
      !["failed", "missing", "running-timeout"].includes(record.status) ||
      (record.repairStatus !== "pending" && record.repairStatus !== "running") ||
      record.reportPath === undefined
    )
      continue;
    if (isCoveredByTerminalProjectRecovery(record, terminalClosureRunIds)) {
      if (closedTaskIds.has(record.taskId)) continue;
      input.updateRepairStatus(
        record.taskId,
        "blocked",
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      );
      result.blocked++;
      continue;
    }
    const summaryPath = readFinalSummaryPath(record.reportPath);
    if (summaryPath === undefined) continue;
    const summary = readJson(summaryPath);
    if (summary === undefined) continue;
    const systemGate = readJson(join(dirname(summaryPath), "system-gate.json"));
    result.checked++;
    const queueRecord = input.coordinator
      .list()
      .find((queued) => queued.linkedTaskIds.includes(record.taskId));
    if (queueRecord?.source === "system-self-heal") continue;
    if (
      queueRecord !== undefined &&
      isRepairTerminal(queueRecord.status) &&
      queueRecord.source === "project-recovery" &&
      hasLinkedAcceptedBlockedRecoveryArtifact(queueRecord.linkedTaskIds, byTaskId)
    ) {
      const summary =
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.";
      for (const closure of linkedAcceptedBlockedClosureRecords(
        queueRecord.linkedTaskIds,
        [record],
        byTaskId,
      )) {
        input.updateRepairStatus(closure.taskId, "blocked", summary);
      }
      result.blocked++;
      continue;
    }
    if (queueRecord !== undefined && isRepairTerminal(queueRecord.status)) continue;
    const reviewGate = summary.reviewGate;
    const supervisorPassed =
      summary.status === "completed" &&
      summary.finalVerification === "passed" &&
      reviewGate !== null &&
      typeof reviewGate === "object" &&
      (reviewGate as Record<string, unknown>).decision === "pass";
    if (supervisorPassed && acceptedCompletedSystemGate(summaryPath, summary, systemGate)) {
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
    if (supervisorPassed) {
      input.updateRepairStatus(
        record.taskId,
        "pending",
        "Passing supervisor summary is missing a matching accepted system gate; returned to the repair queue.",
      );
      if (queueRecord !== undefined) input.coordinator.releaseToQueue(queueRecord.id, input.now);
      continue;
    }
    if (isAcceptedBlockedNoRepairSummary(summary, systemGate)) {
      input.updateRepairStatus(
        record.taskId,
        "not-reproducible",
        "Closed from the authoritative accepted recovery summary; recovery verified the original blocker but no project repair was applicable.",
      );
      if (queueRecord !== undefined)
        input.coordinator.markTerminal(queueRecord.id, "not-reproducible", input.now);
      result.blocked++;
      continue;
    }
    if (summary.status === "blocked" && hasRetryableProjectRecoveryEvidence(summary, systemGate)) {
      if (queueRecord === undefined) {
        input.updateRepairStatus(
          record.taskId,
          "pending",
          "Authoritative supervisor final summary reports retryable automation recovery evidence; returned to the repair queue.",
        );
      } else {
        transitionRetryableArtifact({
          coordinator: input.coordinator,
          queueRecordId: queueRecord.id,
          terminalRecord: record,
          now: input.now,
          records: [record],
          updateRepairStatus: input.updateRepairStatus,
          result,
        });
      }
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

function transitionRetryableArtifact(input: {
  terminalRecord: ScheduledTaskRecord;
  coordinator: RepairCoordinator;
  queueRecordId: string;
  now: number;
  records: readonly ScheduledTaskRecord[];
  updateRepairStatus: (
    taskId: string,
    repairStatus: ScheduledTaskRepairStatus,
    summary: string,
  ) => void;
  result: ProjectRecoveryArtifactReconciliationResult;
}): string[] {
  const records = [...new Map(input.records.map((record) => [record.taskId, record])).values()];
  const taskIds = records.map((record) => record.taskId);
  const summaryPath =
    input.terminalRecord.reportPath === undefined
      ? undefined
      : readFinalSummaryPath(input.terminalRecord.reportPath);
  const gate =
    summaryPath === undefined
      ? undefined
      : readJson(join(dirname(summaryPath), "system-gate.json"));
  const released = input.coordinator.releaseForRetry(input.queueRecordId, input.now, {
    detachWorkOrder: true,
    settledTaskId: input.terminalRecord.taskId,
    ...(typeof gate?.workOrderId === "string" ? { expectedWorkOrderId: gate.workOrderId } : {}),
  });
  const settled =
    released ??
    input.coordinator
      .list()
      .find(
        (record) =>
          record.id === input.queueRecordId &&
          record.workOrderId === undefined &&
          ["pending", "retry-wait", "dead-letter"].includes(record.status) &&
          record.settledRecoveryTaskIds?.includes(input.terminalRecord.taskId),
      );
  if (settled === undefined) return taskIds;
  const exhausted = settled.status === "dead-letter";
  const repairStatus = exhausted ? "blocked" : "pending";
  const summary = exhausted
    ? "Recovery classification: recovery attempt limit reached; repair moved to dead-letter."
    : "Authoritative supervisor final summary reports retryable automation recovery evidence; returned to the repair queue.";
  // Recover a crash after queue settlement but before the ledger projection.
  for (const record of records) {
    if (released !== undefined || record.repairStatus !== repairStatus)
      input.updateRepairStatus(record.taskId, repairStatus, summary);
  }
  if (exhausted && released !== undefined) input.result.blocked++;
  return taskIds;
}

function isTerminalLinkedRepairRecord(record: ScheduledTaskRecord): boolean {
  return (
    record.status === "success" ||
    record.repairStatus === "fixed" ||
    record.repairStatus === "not-needed" ||
    record.repairStatus === "superseded" ||
    record.repairStatus === "not-reproducible"
  );
}

function linkedOriginalsFixedBySuccessfulCounterpart(
  records: readonly ScheduledTaskRecord[],
): ScheduledTaskRecord[] {
  const successfulDelegatedRunIds = new Set(
    records
      .filter(
        (record) =>
          record.source === "autopilot-delegate" &&
          record.status === "success" &&
          isTerminalLinkedRepairRecord(record),
      )
      .flatMap((record) => taskIdRunAliases(record.taskId)),
  );
  if (successfulDelegatedRunIds.size === 0) return [];
  return records.filter(
    (record) =>
      record.source === "loop-engineering" &&
      record.taskId.includes(":active-delegated-task:") &&
      ["failed", "missing", "running-timeout"].includes(record.status) &&
      (record.repairStatus === "pending" ||
        record.repairStatus === "running" ||
        record.repairStatus === "blocked") &&
      taskIdRunAliases(record.taskId).some((runId) => successfulDelegatedRunIds.has(runId)),
  );
}

function linkedRepairQueueStatus(
  records: readonly ScheduledTaskRecord[],
): "fixed" | "superseded" | "not-reproducible" {
  if (records.some((record) => record.status === "success" || record.repairStatus === "fixed"))
    return "fixed";
  if (records.every((record) => record.repairStatus === "superseded")) return "superseded";
  return "not-reproducible";
}

function closeLinkedProjectRecoveryQueues(
  coordinator: RepairCoordinator,
  taskId: string,
  now: number,
): void {
  for (const queued of coordinator.list()) {
    if (queued.source !== "project-recovery") continue;
    if (isRepairTerminal(queued.status)) continue;
    if (!queued.linkedTaskIds.includes(taskId)) continue;
    coordinator.markTerminal(queued.id, "blocked", now);
  }
}

function dedupeWorkOrdersByRunDir(
  records: readonly UnfinishedLoopSupervisorWorkOrder[],
): UnfinishedLoopSupervisorWorkOrder[] {
  return [...new Map(records.map((record) => [record.runDir, record])).values()];
}

function isAcceptedBlockedNoRepairSummary(
  summary: Record<string, unknown>,
  systemGate: Record<string, unknown> | undefined,
): boolean {
  const reviewGate = summary.reviewGate;
  return (
    summary.status === "blocked" &&
    reviewGate !== null &&
    typeof reviewGate === "object" &&
    (reviewGate as Record<string, unknown>).decision === "block" &&
    systemGate?.accepted === true &&
    systemGate.resultStatus === "blocked" &&
    !hasRetryableProjectRecoveryEvidence(summary, systemGate)
  );
}

function acceptedCompletedSystemGate(
  summaryPath: string,
  summary: Record<string, unknown>,
  systemGate: Record<string, unknown> | undefined,
): boolean {
  const normalizedReviewGate = parseSupervisorReviewGate(summary.reviewGate);
  return (
    systemGate?.accepted === true &&
    systemGate.resultStatus === "completed" &&
    systemGate.workOrderId === basename(dirname(summaryPath)) &&
    systemGate.projectId === summary.projectId &&
    (isDeepStrictEqual(systemGate.supervisorReviewGate, summary.reviewGate) ||
      (normalizedReviewGate !== null &&
        isDeepStrictEqual(systemGate.supervisorReviewGate, normalizedReviewGate)))
  );
}

function isRepairTerminal(status: string): boolean {
  return ["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(status);
}

function isTerminalProjectRecoveryClosure(record: { summaries: readonly string[] }): boolean {
  return record.summaries.some(hasGenericProjectRecoveryClosure);
}

function terminalProjectRecoveryRunIds(coordinator: RepairCoordinator): Set<string> {
  return new Set(
    coordinator
      .list()
      .filter(
        (record) =>
          record.source === "project-recovery" && isTerminalProjectRecoveryClosure(record),
      )
      .flatMap((record) => record.linkedTaskIds)
      .map((taskId) => /^autopilot:([^:]+)$/.exec(taskId)?.[1])
      .filter((runId): runId is string => runId !== undefined)
      .flatMap((runId) => runIdAliases(runId)),
  );
}

function hasLinkedAcceptedBlockedRecoveryArtifact(
  linkedTaskIds: readonly string[],
  byTaskId: ReadonlyMap<string, ScheduledTaskRecord>,
): boolean {
  return linkedAcceptedBlockedClosureRecords(linkedTaskIds, [], byTaskId).some((record) =>
    acceptedBlockedRecoveryArtifact(record.reportPath),
  );
}

function isCoveredByTerminalProjectRecovery(
  record: ScheduledTaskRecord,
  terminalClosureRunIds: ReadonlySet<string>,
): boolean {
  if (hasOriginalRecoveryRetryEvidence(record)) return false;
  if (record.repairStatus !== "pending" && record.repairStatus !== "running") return false;
  if (!["failed", "missing", "running-timeout"].includes(record.status)) return false;
  if (record.source === "autopilot-delegate") {
    const runId = /^autopilot:([^:]+)$/.exec(record.taskId)?.[1];
    return runId !== undefined && terminalClosureRunIds.has(runId);
  }
  if (record.source !== "loop-engineering") return false;
  if (!record.taskId.includes(":active-delegated-task:")) return false;
  const runId = record.taskId.split(":").at(-1);
  return runId !== undefined && terminalClosureRunIds.has(runId);
}

function linkedAcceptedBlockedClosureRecords(
  linkedTaskIds: readonly string[],
  linkedRecords: readonly ScheduledTaskRecord[],
  byTaskId: ReadonlyMap<string, ScheduledTaskRecord>,
): ScheduledTaskRecord[] {
  const runIds = new Set(
    linkedTaskIds
      .map((taskId) => /^autopilot:([^:]+)$/.exec(taskId)?.[1])
      .filter((runId): runId is string => runId !== undefined)
      .flatMap((runId) => runIdAliases(runId)),
  );
  const records = new Map(linkedRecords.map((record) => [record.taskId, record]));
  for (const taskId of linkedTaskIds) {
    const record = byTaskId.get(taskId);
    if (record !== undefined) records.set(taskId, record);
  }
  for (const runId of runIds) {
    for (const [taskId, record] of byTaskId) {
      if (taskId === `autopilot:${runId}` || taskId.endsWith(`:${runId}`)) {
        records.set(taskId, record);
      }
    }
  }
  return [...records.values()].filter(
    (record) =>
      ["failed", "missing", "running-timeout"].includes(record.status) &&
      (record.repairStatus === undefined ||
        record.repairStatus === "pending" ||
        record.repairStatus === "running" ||
        record.repairStatus === "blocked"),
  );
}

function runIdAliases(runId: string): string[] {
  const aliases = [runId];
  const timestampPrefix = /^(\d+)-/.exec(runId)?.[1];
  if (timestampPrefix !== undefined) aliases.push(timestampPrefix);
  return aliases;
}

function taskIdRunAliases(taskId: string): string[] {
  const autopilotRunId = /^autopilot:([^:]+)$/.exec(taskId)?.[1];
  if (autopilotRunId !== undefined) return runIdAliases(autopilotRunId);
  if (!taskId.includes(":active-delegated-task:")) return [];
  const runId = taskId.split(":").at(-1);
  return runId === undefined ? [] : runIdAliases(runId);
}

function linkedTerminalClosureRecords(
  linkedTaskIds: readonly string[],
  linkedRecords: readonly ScheduledTaskRecord[],
  byTaskId: ReadonlyMap<string, ScheduledTaskRecord>,
): ScheduledTaskRecord[] {
  const runIds = new Set(
    linkedTaskIds
      .map((taskId) => /^autopilot:([^:]+)$/.exec(taskId)?.[1])
      .filter((runId): runId is string => runId !== undefined)
      .flatMap((runId) => runIdAliases(runId)),
  );
  const records = new Map(linkedRecords.map((record) => [record.taskId, record]));
  for (const runId of runIds) {
    for (const [taskId, record] of byTaskId) {
      if (!taskId.endsWith(`:${runId}`)) continue;
      if (!taskId.includes(":active-delegated-task:")) continue;
      records.set(taskId, record);
    }
  }
  return [...records.values()].filter(
    (record) =>
      ["failed", "missing", "running-timeout"].includes(record.status) &&
      (record.repairStatus === "pending" ||
        record.repairStatus === "running" ||
        record.repairStatus === "blocked"),
  );
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

function acceptedBlockedRecoveryArtifact(reportPath: string | undefined): boolean {
  if (reportPath === undefined) return false;
  const summaryPath = readFinalSummaryPath(reportPath);
  if (summaryPath === undefined) return false;
  const summary = readJson(summaryPath);
  const systemGate = readJson(join(dirname(summaryPath), "system-gate.json"));
  if (summary === undefined) return false;
  return isAcceptedBlockedNoRepairSummary(summary, systemGate);
}

function retryableBlockedRecoveryArtifact(reportPath: string | undefined): boolean {
  if (reportPath === undefined) return false;
  const summaryPath = readFinalSummaryPath(reportPath);
  if (summaryPath === undefined) return false;
  const summary = readJson(summaryPath);
  if (summary === undefined || summary.status !== "blocked") return false;
  const systemGate = readJson(join(dirname(summaryPath), "system-gate.json"));
  return hasRetryableProjectRecoveryEvidence(summary, systemGate);
}

function hasRetryableProjectRecoveryEvidence(
  summary: Record<string, unknown>,
  systemGate: Record<string, unknown> | undefined,
): boolean {
  if (hasAuthoritativeRetryConflict(systemGate)) return false;
  if (hasBotRepairableSystemGateFinding(systemGate)) return true;
  const reviewGate =
    summary.reviewGate !== null && typeof summary.reviewGate === "object"
      ? (summary.reviewGate as Record<string, unknown>)
      : {};
  const evidence = [
    summary.finalVerification,
    summary.error,
    summary.actionsTaken,
    summary.followUps,
    reviewGate.notes,
    reviewGate.deterministicGates,
  ]
    .map((value) => (value === undefined ? "" : JSON.stringify(value)))
    .join(" ");
  return isRetryableSourceGitStateEvidence(evidence) || hasPreciseBotRetryableEvidence(evidence);
}

function hasAuthoritativeRetryConflict(systemGate: Record<string, unknown> | undefined): boolean {
  if (systemGate === undefined) return false;
  if (systemGate.repairDisposition === "target-or-external-blocker") return true;
  if (Array.isArray(systemGate.failures) && systemGate.failures.length > 0) return true;
  return (
    Array.isArray(systemGate.findings) &&
    systemGate.findings.some(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        ((finding as Record<string, unknown>).repairDisposition === "target-or-external-blocker" ||
          (finding as Record<string, unknown>).retry === "manual"),
    )
  );
}

function hasBotRepairableSystemGateFinding(
  systemGate: Record<string, unknown> | undefined,
): boolean {
  if (
    systemGate?.accepted !== true ||
    systemGate.resultStatus !== "blocked" ||
    systemGate.repairDisposition !== "bot-repairable" ||
    (Array.isArray(systemGate.failures) && systemGate.failures.length > 0)
  )
    return false;
  return (
    Array.isArray(systemGate.findings) &&
    systemGate.findings.some(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        (finding as Record<string, unknown>).code === "stale-runtime-source-adoption" &&
        (finding as Record<string, unknown>).repairDisposition === "bot-repairable" &&
        (finding as Record<string, unknown>).retry === "automatic" &&
        Array.isArray((finding as Record<string, unknown>).evidence) &&
        ((finding as Record<string, unknown>).evidence as unknown[]).some(
          (item) => typeof item === "string" && item.trim().length > 0,
        ),
    )
  );
}

function hasPreciseBotRetryableEvidence(evidence: string): boolean {
  const normalized = evidence.toLowerCase();
  return (
    normalized.includes("score:null") ||
    normalized.includes("assessment score contract") ||
    normalized.includes("assessment scoring contract") ||
    normalized.includes("assessment result did not include a numeric score") ||
    normalized.includes("control request timed out") ||
    normalized.includes("dispatch-failed") ||
    normalized.includes("failed to ensure loop supervisor session") ||
    normalized.includes("spawnsync /usr/bin/git enoent")
  );
}

function readRecoveryArtifact(reportPath: string): { artifactText?: string; targetIds: string[] } {
  const basePath =
    reportPath.endsWith(".md") || reportPath.endsWith(".json") ? dirname(reportPath) : reportPath;
  const workOrderPath = join(basePath, "work-order.json");
  const targetIds: string[] = [];
  try {
    const workOrder = JSON.parse(readFileSync(workOrderPath, "utf8"));
    for (const id of [workOrder.projectId, workOrder.workspace?.id]) {
      if (typeof id === "string") targetIds.push(id);
    }
    // Legacy recovery prompts carry explicit routing labels, not diagnostic evidence.
    for (const text of [workOrder.task?.requirement, workOrder.goal]) {
      if (typeof text === "string") targetIds.push(...extractExplicitTargetIds(text));
    }
  } catch {
    // Missing or invalid instructions cannot supply routing authority.
  }
  const paths = [
    join(basePath, "system-gate.json"),
    join(basePath, "supervisor-final-summary.json"),
    join(basePath, "supervisor-summary.json"),
    reportPath,
  ];
  const seen = new Set<string>();
  const evidence = paths
    .filter((path) => {
      if (path === workOrderPath || seen.has(path)) return false;
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
  return {
    targetIds,
    ...(evidence.length === 0 ? {} : { artifactText: evidence.join("\n").slice(0, 32_000) }),
  };
}
