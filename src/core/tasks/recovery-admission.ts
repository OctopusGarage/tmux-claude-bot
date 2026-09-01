import type { RepairCoordinator, RepairQueueRecord } from "./repair-coordinator.js";

export type RecoveryFinding = {
  projectId: string;
  projectPath: string;
  source: string;
  taskFamily: string;
  fingerprint: string;
  taskId: string;
  summary?: string;
  priority: number;
  /** A known ownership boundary that must remain auditable but never dispatch. */
  terminalStatus?: "blocked";
};

export type RecoveryAdmissionDispatchResult =
  | { status: "queued"; detail: string; runId?: string }
  | { status: "blocked"; detail: string };

export type RecoveryAdmissionResult = {
  disposition: "not-needed" | "queued" | "deferred" | "blocked";
  admitted: number;
  claimed: number;
  detail: string;
};

export async function admitRecoveryFindings(input: {
  findings: readonly RecoveryFinding[];
  coordinator: RepairCoordinator;
  now: number;
  leaseId: string;
  dispatch: (records: readonly RepairQueueRecord[]) => Promise<RecoveryAdmissionDispatchResult>;
}): Promise<RecoveryAdmissionResult> {
  for (const finding of input.findings) {
    input.coordinator.enqueue({ ...finding, now: input.now });
  }
  if (input.findings.length === 0)
    return { disposition: "not-needed", admitted: 0, claimed: 0, detail: "no findings" };

  const terminalFindings = input.findings.filter(
    (finding): finding is RecoveryFinding & { terminalStatus: "blocked" } =>
      finding.terminalStatus !== undefined,
  );
  for (const finding of terminalFindings) {
    const record = findRecordForFinding(input.coordinator, finding);
    if (record !== undefined)
      input.coordinator.markTerminal(record.id, finding.terminalStatus, input.now);
  }
  const dispatchableFindings = input.findings.filter(
    (finding) => finding.terminalStatus === undefined,
  );
  if (dispatchableFindings.length === 0) {
    return {
      disposition: "blocked",
      admitted: input.findings.length,
      claimed: 0,
      detail: "terminal blocked findings recorded; no bot self-repair dispatched",
    };
  }

  const claimed = input.coordinator.claimIds(
    dispatchableFindings
      .map((finding) => findRecordForFinding(input.coordinator, finding)?.id)
      .filter((id): id is string => id !== undefined),
    { now: input.now, leaseId: input.leaseId, limit: dispatchableFindings.length },
  );
  if (claimed.length === 0)
    return {
      disposition: "not-needed",
      admitted: input.findings.length,
      claimed: 0,
      detail: "no due findings",
    };

  const dispatch = await input.dispatch(claimed);
  if (dispatch.status === "queued") {
    for (const record of claimed)
      input.coordinator.markRunning(record.id, input.leaseId, input.now);
    return {
      disposition: "queued",
      admitted: input.findings.length,
      claimed: claimed.length,
      detail: dispatch.detail,
    };
  }
  const deferred = isImmediateRecoveryDeferral(dispatch.detail);
  for (const record of claimed) {
    if (deferred) input.coordinator.releaseToQueue(record.id, input.now);
    else input.coordinator.releaseForRetry(record.id, input.now);
  }
  return {
    disposition: deferred ? "deferred" : "blocked",
    admitted: input.findings.length,
    claimed: claimed.length,
    detail: dispatch.detail,
  };
}

function findRecordForFinding(
  coordinator: RepairCoordinator,
  finding: RecoveryFinding,
): RepairQueueRecord | undefined {
  const active = coordinator
    .list()
    .filter((record) => !TERMINAL_REPAIR_STATUSES.has(record.status));
  return (
    active.find(
      (record) =>
        record.projectId === finding.projectId &&
        record.taskFamily === finding.taskFamily &&
        record.fingerprint === finding.fingerprint,
    ) ??
    (finding.source === "runtime-guardian"
      ? active.find(
          (record) =>
            record.source === "runtime-guardian" &&
            record.projectId === finding.projectId &&
            record.taskFamily === finding.taskFamily &&
            record.linkedTaskIds.includes(finding.taskId),
        )
      : undefined)
  );
}

const TERMINAL_REPAIR_STATUSES = new Set([
  "fixed",
  "blocked",
  "not-reproducible",
  "superseded",
  "dead-letter",
]);

export async function dispatchRecoveryQueue<T>(input: {
  coordinator: RepairCoordinator;
  now: number;
  leaseId: string;
  projectId: string;
  limit: number;
  excludeSources?: readonly string[];
  resolve: (records: readonly RepairQueueRecord[]) => T[];
  dispatch: (items: readonly T[]) => Promise<RecoveryAdmissionDispatchResult | undefined>;
  onQueued: (
    records: readonly RepairQueueRecord[],
    result: Extract<RecoveryAdmissionDispatchResult, { status: "queued" }> | undefined,
  ) => void;
}): Promise<RecoveryAdmissionResult> {
  const claimed = input.coordinator.claimDue({
    now: input.now,
    leaseId: input.leaseId,
    limit: input.limit,
    projectId: input.projectId,
    ...(input.excludeSources === undefined ? {} : { excludeSources: input.excludeSources }),
  });
  if (claimed.length === 0)
    return { disposition: "not-needed", admitted: 0, claimed: 0, detail: "no due findings" };
  const items = input.resolve(claimed);
  if (items.length === 0) {
    for (const record of claimed) input.coordinator.markTerminal(record.id, "blocked", input.now);
    return {
      disposition: "blocked",
      admitted: 0,
      claimed: claimed.length,
      detail: "no ledger evidence",
    };
  }
  try {
    const result = await input.dispatch(items);
    if (result?.status === "blocked") {
      const deferred = isImmediateRecoveryDeferral(result.detail);
      for (const record of claimed) {
        if (deferred) input.coordinator.releaseToQueue(record.id, input.now);
        else input.coordinator.releaseForRetry(record.id, input.now);
      }
      return {
        disposition: deferred ? "deferred" : "blocked",
        admitted: items.length,
        claimed: claimed.length,
        detail: result.detail,
      };
    }
    for (const record of claimed)
      input.coordinator.markRunning(record.id, input.leaseId, input.now);
    input.onQueued(claimed, result?.status === "queued" ? result : undefined);
    return {
      disposition: "queued",
      admitted: items.length,
      claimed: claimed.length,
      detail: result?.detail ?? "queued",
    };
  } catch {
    for (const record of claimed) input.coordinator.releaseForRetry(record.id, input.now);
    return {
      disposition: "blocked",
      admitted: items.length,
      claimed: claimed.length,
      detail: "dispatch failed",
    };
  }
}

export function isImmediateRecoveryDeferral(detail: string): boolean {
  return /(capacity|active automation|queue full|supervisor.*(busy|lease)|interactive-agent-busy|automation admission deferred|no available)/i.test(
    detail,
  );
}
