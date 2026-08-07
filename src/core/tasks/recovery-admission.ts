import { type RepairQueueRecord, RepairCoordinator } from "./repair-coordinator.js";

export type RecoveryFinding = {
  projectId: string;
  projectPath: string;
  source: string;
  taskFamily: string;
  fingerprint: string;
  taskId: string;
  summary?: string;
  priority: number;
};

export type RecoveryAdmissionDispatchResult =
  | { status: "queued"; detail: string }
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

  const claimed = input.coordinator.claimIds(
    input.findings
      .map((finding) =>
        input.coordinator
          .list()
          .find(
            (record) =>
              record.projectId === finding.projectId &&
              record.taskFamily === finding.taskFamily &&
              record.fingerprint === finding.fingerprint,
          )?.id,
      )
      .filter((id): id is string => id !== undefined),
    { now: input.now, leaseId: input.leaseId, limit: input.findings.length },
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
    for (const record of claimed) input.coordinator.markRunning(record.id, input.leaseId, input.now);
    return {
      disposition: "queued",
      admitted: input.findings.length,
      claimed: claimed.length,
      detail: dispatch.detail,
    };
  }
  const deferred = isImmediateDeferral(dispatch.detail);
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

function isImmediateDeferral(detail: string): boolean {
  return /(capacity|active automation|queue full|supervisor.*busy|no available)/i.test(detail);
}
