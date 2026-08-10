import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loopRunDir } from "../loop/artifacts.js";
import { readLoopSupervisorWorkOrderRegistry } from "../loop/supervisor-state.js";
import { type LoopWorkOrder, parseSupervisorFinalSummaryFile } from "../loop/work-order.js";
import type { RepairCoordinator } from "../tasks/repair-coordinator.js";
import type { RuntimeGuardianFinding, RuntimeGuardianFindingKind } from "./findings.js";

const RUNTIME_GUARDIAN_FINDING_KINDS = new Set<RuntimeGuardianFindingKind>([
  "missing-system-gate",
  "terminal-system-gate-failure",
  "failed-eval-outcome",
  "terminal-invalid-output",
  "terminal-agent-transient-failure",
  "terminal-work-order-active-lease",
  "stale-dispatching-work-order",
  "read-only-smoke-preflight-blocked",
]);

export function isTargetOrExternalBlocker(finding: RuntimeGuardianFinding): boolean {
  return finding.repairDisposition === "target-or-external-blocker";
}

export function reconcileRuntimeGuardianQueue(input: {
  coordinator: RepairCoordinator;
  now: number;
  findings: readonly RuntimeGuardianFinding[];
}): number {
  const byRunId = new Map(input.findings.map((finding) => [finding.runId, finding]));
  const registry = readLoopSupervisorWorkOrderRegistry(input.now);
  let reconciled = recoverRuntimeGuardianWorkOrderLinks({
    coordinator: input.coordinator,
    now: input.now,
    workOrders: registry.records,
  });
  const terminalByRunId = new Map(registry.terminal.map((record) => [record.workOrder.id, record]));
  for (const record of input.coordinator.list()) {
    if (record.source !== "runtime-guardian" || isQueueTerminal(record.status)) continue;
    const repairWorkOrder =
      record.workOrderId === undefined ? undefined : terminalByRunId.get(record.workOrderId);
    if (repairWorkOrder !== undefined) {
      if (repairWorkOrder.state.status === "completed") {
        input.coordinator.markTerminal(record.id, "fixed", input.now);
      } else {
        input.coordinator.releaseForRetry(record.id, input.now, { detachWorkOrder: true });
      }
      reconciled++;
      continue;
    }
    const finding = record.linkedTaskIds.map((id) => byRunId.get(id)).find(Boolean);
    if (finding !== undefined && isTargetOrExternalBlocker(finding)) {
      input.coordinator.markTerminal(record.id, "blocked", input.now);
      reconciled++;
      continue;
    }
    if (record.taskFamily !== "terminal-invalid-output") continue;
    const terminal = record.linkedTaskIds.map((id) => terminalByRunId.get(id)).find(Boolean);
    const evidence =
      terminal === undefined
        ? record.linkedTaskIds
            .map((id) => readPassingTerminalArtifacts(loopRunDir(record.projectId, id)))
            .find(Boolean)
        : readPassingTerminalArtifacts(terminal.runDir, terminal.workOrder);
    if (evidence === false) continue;
    input.coordinator.markTerminal(
      record.id,
      evidence === "fixed" ? "fixed" : "not-reproducible",
      input.now,
    );
    reconciled++;
  }
  return reconciled;
}

function recoverRuntimeGuardianWorkOrderLinks(input: {
  coordinator: RepairCoordinator;
  now: number;
  workOrders: ReturnType<typeof readLoopSupervisorWorkOrderRegistry>["records"];
}): number {
  let recovered = 0;
  for (const record of input.coordinator.list()) {
    if (
      record.source !== "runtime-guardian" ||
      record.workOrderId !== undefined ||
      !["pending", "leased", "running", "retry-wait"].includes(record.status)
    )
      continue;
    const candidate = input.workOrders
      .filter(({ workOrder }) => {
        const requirement =
          workOrder.task?.kind === "active-delegated-task" ? workOrder.task.requirement : undefined;
        return (
          requirement?.includes("source=runtime-guardian") &&
          workOrder.scheduledAt >= record.createdAt &&
          workOrder.scheduledAt <= input.now &&
          record.linkedTaskIds.every((taskId) => requirement.includes(JSON.stringify(taskId)))
        );
      })
      .sort((a, b) => b.workOrder.scheduledAt - a.workOrder.scheduledAt)[0];
    if (candidate === undefined) continue;
    if (record.status === "pending" || record.status === "retry-wait") {
      const leaseId = `runtime-guardian-recovered:${candidate.workOrder.id}`;
      const claimed = input.coordinator.claimIds([record.id], {
        now: input.now,
        leaseId,
        limit: 1,
      });
      if (claimed.length !== 1) continue;
      input.coordinator.markRunning(record.id, leaseId, input.now);
    } else if (record.status === "leased") {
      if (record.leaseId === undefined) continue;
      input.coordinator.markRunning(record.id, record.leaseId, input.now);
    }
    input.coordinator.attachWorkOrder(record.id, candidate.workOrder.id, input.now);
    input.coordinator.linkTaskIds(record.id, [`autopilot:${candidate.workOrder.id}`], input.now);
    recovered++;
  }
  return recovered;
}

export function dueRuntimeGuardianFindings(input: {
  coordinator: RepairCoordinator;
  now: number;
  limit: number;
}): RuntimeGuardianFinding[] {
  return input.coordinator
    .list()
    .filter(
      (record) =>
        record.source === "runtime-guardian" &&
        (record.status === "pending" || record.status === "retry-wait") &&
        record.nextAttemptAt <= input.now &&
        isRuntimeGuardianFindingKind(record.taskFamily),
    )
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
    .slice(0, Math.max(0, input.limit))
    .map((record) => ({
      kind: record.taskFamily as RuntimeGuardianFindingKind,
      severity: record.priority >= 100 ? "high" : "medium",
      runId: record.linkedTaskIds.at(-1) ?? record.id,
      projectId: record.projectId,
      projectPath: record.projectPath,
      evidence: record.summaries.length > 0 ? record.summaries : [record.fingerprint],
    }));
}

function isQueueTerminal(status: string): boolean {
  return ["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(status);
}
function isRuntimeGuardianFindingKind(value: string): value is RuntimeGuardianFindingKind {
  return RUNTIME_GUARDIAN_FINDING_KINDS.has(value as RuntimeGuardianFindingKind);
}
function readPassingTerminalArtifacts(
  runDir: string,
  workOrder?: LoopWorkOrder,
): "fixed" | "not-reproducible" | false {
  const candidate =
    workOrder ?? (readJsonRecord(join(runDir, "work-order.json")) as LoopWorkOrder | null);
  if (candidate === null) return false;
  const parsed = parseSupervisorFinalSummaryFile(candidate);
  const gate = readJsonRecord(join(runDir, "system-gate.json"));
  const summary = readJsonRecord(join(runDir, "supervisor-final-summary.json"));
  if (summary === null) return false;
  const success =
    summary.status === "completed" &&
    summary.finalVerification === "passed" &&
    isRecord(summary.reviewGate) &&
    summary.reviewGate.decision === "pass";
  if (success) return parsed.ok ? "fixed" : "not-reproducible";
  return gate?.accepted === true && !parsed.ok ? "not-reproducible" : false;
}
function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
