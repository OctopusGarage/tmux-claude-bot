import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loopRunDir } from "../loop/artifacts.js";
import { listTerminalLoopSupervisorWorkOrders } from "../loop/supervisor-state.js";
import { type LoopWorkOrder, parseSupervisorFinalSummaryFile } from "../loop/work-order.js";
import type { RepairCoordinator } from "../tasks/repair-coordinator.js";
import type { RuntimeGuardianFinding } from "./findings.js";

export function isTargetOrExternalBlocker(finding: RuntimeGuardianFinding): boolean {
  return finding.repairDisposition === "target-or-external-blocker";
}

export function reconcileRuntimeGuardianQueue(input: {
  coordinator: RepairCoordinator;
  now: number;
  findings: readonly RuntimeGuardianFinding[];
}): number {
  const byRunId = new Map(input.findings.map((finding) => [finding.runId, finding]));
  const terminalByRunId = new Map(
    listTerminalLoopSupervisorWorkOrders().map((record) => [record.workOrder.id, record]),
  );
  let reconciled = 0;
  for (const record of input.coordinator.list()) {
    if (record.source !== "runtime-guardian" || isQueueTerminal(record.status)) continue;
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

function isQueueTerminal(status: string): boolean {
  return ["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(status);
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
