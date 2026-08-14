import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAgentTransientFailure } from "../agents/transient-failure.js";
import {
  buildEvalReportFromSupervisorSummary,
  isPreMutationDependencyGate,
} from "../eval/report.js";
import { readLoopSupervisorWorkerLeaseState } from "../loop/supervisor-pool.js";
import {
  listStaleDispatchingLoopSupervisorWorkOrders,
  listTerminalLoopSupervisorWorkOrders,
  STALE_DISPATCHING_WORK_ORDER_MS,
} from "../loop/supervisor-state.js";
import {
  type LoopSupervisorReviewGateDeterministicGate,
  parseSupervisorFinalSummaryFile,
} from "../loop/work-order.js";
import { DailyTaskLedger } from "../tasks/task-ledger.js";
import type { RuntimeGuardianFinding, RuntimeGuardianRepairDisposition } from "./findings.js";

type TerminalWorkOrder = ReturnType<typeof listTerminalLoopSupervisorWorkOrders>[number];

/** Read durable Loop artifacts and classify repair findings without changing runtime state. */
export function discoverRuntimeGuardianFindings(
  input: { now: number; lookbackMs: number; repoPath?: string } = {
    now: Date.now(),
    lookbackMs: 86_400_000,
  },
): RuntimeGuardianFinding[] {
  const findings: RuntimeGuardianFinding[] = [];
  const terminal = listTerminalLoopSupervisorWorkOrders();
  for (const record of listStaleDispatchingLoopSupervisorWorkOrders(input.now)) {
    if (input.repoPath !== undefined && record.workOrder.projectPath !== input.repoPath) continue;
    if (outsideLookback(record.state.updatedAt, input)) continue;
    findings.push({
      kind: "stale-dispatching-work-order",
      severity: "high",
      runId: record.workOrder.id,
      projectId: record.workOrder.projectId,
      projectPath: record.workOrder.projectPath,
      runDir: record.runDir,
      evidence: [
        `dispatching work-order has no active supervisor lease: ${record.workOrder.id}`,
        `dispatch reservation exceeded ${STALE_DISPATCHING_WORK_ORDER_MS / 1000}s`,
        "no supervisor final summary exists",
      ],
    });
  }
  for (const record of terminal) inspectTerminalRecord(findings, record, input);
  const terminalIds = new Set(terminal.map((record) => record.workOrder.id));
  for (const lease of readLoopSupervisorWorkerLeaseState().leases) {
    if (lease.status !== "active" || !terminalIds.has(lease.workOrderId)) continue;
    findings.push({
      kind: "terminal-work-order-active-lease",
      severity: "high",
      runId: lease.workOrderId,
      projectId: lease.projectId,
      projectPath: lease.projectPath,
      evidence: [
        `active supervisor worker lease remains for terminal work-order: ${lease.workOrderId}`,
        `workerSession: ${lease.workerSession}`,
      ],
    });
  }
  return findings;
}

function inspectTerminalRecord(
  findings: RuntimeGuardianFinding[],
  record: TerminalWorkOrder,
  input: { now: number; lookbackMs: number },
): void {
  if (outsideLookback(record.state.updatedAt, input)) return;
  if (hasTerminalLedgerClosure(record)) return;
  const gatePath = join(record.runDir, "system-gate.json");
  const finalSummaryPath =
    record.workOrder.finalSummaryPath ?? join(record.runDir, "supervisor-final-summary.json");
  for (const finding of [
    systemGateFailure(record, gatePath, finalSummaryPath),
    failedEval(record, gatePath),
    invalidOutput(record, gatePath, finalSummaryPath),
    transientFailure(record),
    readOnlySmokeBlocked(record, finalSummaryPath),
  ]) {
    if (finding !== null) findings.push(finding);
  }
  if (
    record.state.status === "completed" &&
    existsSync(finalSummaryPath) &&
    !existsSync(gatePath)
  ) {
    findings.push(
      findingFor(record, "missing-system-gate", "high", [
        `terminal completed work-order exists: ${record.workOrder.id}`,
        `supervisor final summary exists: ${finalSummaryPath}`,
        `system gate evidence is missing: ${gatePath}`,
      ]),
    );
  }
}

const CLOSED_LEDGER_REPAIR_STATUSES = new Set([
  "fixed",
  "not-needed",
  "not-reproducible",
  "superseded",
]);

function hasTerminalLedgerClosure(record: TerminalWorkOrder): boolean {
  const runId = record.workOrder.id;
  return new DailyTaskLedger().listAll().some((entry) => {
    if (!CLOSED_LEDGER_REPAIR_STATUSES.has(entry.repairStatus ?? "")) return false;
    return entry.taskId.includes(runId) || entry.reportPath?.includes(runId) === true;
  });
}

function systemGateFailure(
  record: TerminalWorkOrder,
  gatePath: string,
  finalSummaryPath: string,
): RuntimeGuardianFinding | null {
  if (
    record.state.status !== "failed" ||
    record.state.resultStatus !== "supervisor-failed" ||
    !existsSync(gatePath)
  )
    return null;
  const parsed = readJson(gatePath);
  if (parsed?.accepted !== false) return null;
  const failures = Array.isArray(parsed.failures)
    ? parsed.failures.filter((value): value is string => typeof value === "string")
    : [];
  const recoverableFailures = Array.isArray(parsed.recoverableFailures)
    ? parsed.recoverableFailures.filter((value): value is string => typeof value === "string")
    : [];
  const structured = Array.isArray(parsed.findings) ? parsed.findings : [];
  const structuredDisposition =
    structured
      .map((value) => (isRecord(value) ? value.repairDisposition : undefined))
      .find(
        (value): value is RuntimeGuardianRepairDisposition =>
          value === "bot-repairable" || value === "target-or-external-blocker",
      ) ??
    (parsed.repairDisposition === "bot-repairable" ||
    parsed.repairDisposition === "target-or-external-blocker"
      ? parsed.repairDisposition
      : undefined);
  const disposition =
    structuredDisposition ??
    (failures.some(isTargetOrExternalSystemGateFailure) ? "target-or-external-blocker" : undefined);
  if (
    disposition === undefined &&
    failures.length > 0 &&
    recoverableFailures.length === failures.length &&
    failures.every((failure) => recoverableFailures.includes(failure))
  ) {
    return null;
  }
  if (
    disposition === undefined &&
    hasRawSuccessfulSummary(finalSummaryPath) &&
    failures.length > 0 &&
    failures.every((failure) =>
      isIgnorableLegacySuccessfulSummaryFailure(record, finalSummaryPath, failure),
    )
  ) {
    return null;
  }
  return {
    ...findingFor(record, "terminal-system-gate-failure", "high", [
      `system gate rejected terminal work-order: ${record.workOrder.id}`,
      `resultStatus: ${record.state.resultStatus ?? "unknown"}`,
      ...(failures.length > 0
        ? failures
        : ["system-gate.json recorded accepted=false without failure details"]),
      `system gate evidence exists: ${gatePath}`,
    ]),
    ...(disposition === undefined ? {} : { repairDisposition: disposition }),
  };
}

function failedEval(record: TerminalWorkOrder, gatePath: string): RuntimeGuardianFinding | null {
  if (record.state.status !== "completed" || !existsSync(gatePath)) return null;
  const outcome = readJson(gatePath)?.evalReport;
  if (!isRecord(outcome) || !isRecord(outcome.outcome)) return null;
  const status = typeof outcome.outcome.status === "string" ? outcome.outcome.status : null;
  if (status === null || status === "passed") return null;
  const reason =
    typeof outcome.outcome.reason === "string" ? outcome.outcome.reason : "no reason recorded";
  return findingFor(record, "failed-eval-outcome", "high", [
    `system gate eval outcome is ${status}: ${reason}`,
    `system gate evidence exists: ${gatePath}`,
  ]);
}

function isTargetOrExternalSystemGateFailure(failure: string): boolean {
  return (
    (failure.startsWith("GitHub account ") && !isLegacyExecutableEnoentFailure(failure)) ||
    failure.startsWith("PR lookup failed:") ||
    failure.startsWith("PR lookup after body cleanup failed:") ||
    failure.startsWith("PR lookup while waiting for checks failed:") ||
    failure.startsWith("PR check wait failed:") ||
    failure.startsWith("CI check ") ||
    failure.startsWith("PR state is ") ||
    failure.startsWith("PR mergeability is ") ||
    failure.startsWith("PR is not mergeable:") ||
    failure.startsWith("unexpected PR commit count:") ||
    failure.startsWith("PR is missing supervisor commit ") ||
    failure.startsWith("PR contains commit outside supervisor summary:") ||
    failure.startsWith("source git status failed:") ||
    failure.startsWith("source worktree is dirty after supervisor completion:") ||
    failure.startsWith("source git branch check failed:") ||
    failure.startsWith("source branch is ")
  );
}

function invalidOutput(
  record: TerminalWorkOrder,
  gatePath: string,
  finalSummaryPath: string,
): RuntimeGuardianFinding | null {
  if (record.state.status !== "failed" || record.state.resultStatus !== "invalid-output")
    return null;
  const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
  if (parsed.ok && parsed.summary.status === "blocked") return null;
  if (!parsed.ok && hasRawBlockedSummary(finalSummaryPath)) return null;
  if (
    parsed.ok &&
    parsed.summary.status === "completed" &&
    parsed.summary.finalVerification === "passed" &&
    existsSync(gatePath)
  ) {
    return null;
  }
  if (
    !parsed.ok &&
    (hasRawSuccessfulSummary(finalSummaryPath) || hasDerivedSuccessfulSummary(record.runDir))
  )
    return null;
  if (isRestartRecoveredActiveDelegationInvalidOutput(record)) return null;
  return findingFor(record, "terminal-invalid-output", "medium", [
    `terminal failed work-order has resultStatus=invalid-output: ${record.workOrder.id}`,
    `runDir: ${record.runDir}`,
    ...(parsed.ok && !existsSync(gatePath) ? [`system gate evidence is missing: ${gatePath}`] : []),
    ...(parsed.ok && parsed.summary.status !== "completed"
      ? [`final summary status is ${parsed.summary.status}`]
      : []),
    ...(parsed.ok && parsed.summary.finalVerification !== "passed"
      ? [`final summary verification is ${parsed.summary.finalVerification}`]
      : []),
  ]);
}

function transientFailure(record: TerminalWorkOrder): RuntimeGuardianFinding | null {
  if (record.state.status !== "failed" || record.state.resultStatus !== "dispatch-failed")
    return null;
  const evidence = [...(record.state.revisionReasons ?? []), readSummaryEvidence(record.runDir)]
    .filter(Boolean)
    .join("\n");
  const transient = classifyAgentTransientFailure(evidence);
  return transient === null
    ? null
    : findingFor(record, "terminal-agent-transient-failure", "medium", [
        `terminal failed work-order has retryable agent transient failure: ${record.workOrder.id}`,
        `transient-kind: ${transient.kind}`,
        evidence,
      ]);
}

function readOnlySmokeBlocked(
  record: TerminalWorkOrder,
  finalSummaryPath: string,
): RuntimeGuardianFinding | null {
  if (
    record.state.status !== "failed" ||
    record.state.resultStatus !== "blocked" ||
    record.workOrder.task?.kind !== "active-delegated-task"
  )
    return null;
  if (
    !record.workOrder.task.requirement.toLowerCase().includes("read-only") ||
    !record.workOrder.task.requirement.toLowerCase().includes("smoke")
  )
    return null;
  if (
    record.workOrder.preflight.commands.length > 0 &&
    record.workOrder.preflight.commands.every(dependencyCommand)
  )
    return null;
  const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
  const gate =
    parsed.ok && parsed.summary.status === "blocked"
      ? parsed.summary.reviewGate?.deterministicGates.find(failedDependencyGate)
      : undefined;
  if (gate === undefined) return null;
  return findingFor(record, "read-only-smoke-preflight-blocked", "medium", [
    `read-only smoke active delegation blocked by target dependency preflight: ${record.workOrder.id}`,
    `supervisor final summary exists: ${finalSummaryPath}`,
    `failed gate: ${typeof gate === "string" ? gate : [gate.name, gate.result, gate.evidence].filter(Boolean).join(" | ")}`,
    "This points to tmux-claude-bot verification-profile/worktree-policy behavior, not a target-project repair.",
  ]);
}

function findingFor(
  record: TerminalWorkOrder,
  kind: RuntimeGuardianFinding["kind"],
  severity: RuntimeGuardianFinding["severity"],
  evidence: string[],
): RuntimeGuardianFinding {
  return {
    kind,
    severity,
    runId: record.workOrder.id,
    projectId: record.workOrder.projectId,
    projectPath: record.workOrder.projectPath,
    runDir: record.runDir,
    evidence,
  };
}
function outsideLookback(updatedAt: number, input: { now: number; lookbackMs: number }): boolean {
  return updatedAt > input.now || input.now - updatedAt > input.lookbackMs;
}
function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasRawSuccessfulSummary(finalSummaryPath: string): boolean {
  const summary = readJson(finalSummaryPath);
  if (summary === null) return false;
  const reviewGate = isRecord(summary.reviewGate) ? summary.reviewGate : null;
  return (
    summary.status === "completed" &&
    summary.finalVerification === "passed" &&
    reviewGate?.decision === "pass"
  );
}
function hasRawBlockedSummary(finalSummaryPath: string): boolean {
  const summary = readJson(finalSummaryPath);
  return summary?.status === "blocked";
}
function hasDerivedSuccessfulSummary(runDir: string): boolean {
  const report = readJson(join(runDir, "supervisor-summary.json"));
  const result = isRecord(report?.result) ? report.result : null;
  const summary = isRecord(result?.summary) ? result.summary : null;
  const reviewGate = isRecord(summary?.reviewGate) ? summary.reviewGate : null;
  const evalReport = readJson(join(runDir, "eval-report.json"));
  const outcome = isRecord(evalReport?.outcome) ? evalReport.outcome : null;
  if (result === null || summary === null || outcome === null) return false;
  return (
    report?.status === "completed" &&
    result.status === "completed" &&
    summary.status === "completed" &&
    summary.finalVerification === "passed" &&
    reviewGate?.decision === "pass" &&
    outcome.status === "passed" &&
    outcome.finalVerification === "passed" &&
    outcome.reviewDecision === "pass"
  );
}
function isLegacyIsolatedBranchMismatchFailure(failure: string): boolean {
  return /^isolated worktree is on "[^"]*", expected WorkOrder branch "[^"]+"$/.test(failure);
}
function isLegacySystemGitEnoentFailure(failure: string): boolean {
  return (
    failure === "git status failed: spawnSync git ENOENT" ||
    failure === "git status failed: spawnSync /usr/bin/git ENOENT" ||
    failure === "isolated worktree branch check failed: spawnSync git ENOENT" ||
    failure === "isolated worktree branch check failed: spawnSync /usr/bin/git ENOENT"
  );
}
function isLegacyExecutableEnoentFailure(failure: string): boolean {
  return /\bspawnSync (?:git|sh|\/usr\/bin\/git|\/bin\/sh|\/usr\/bin\/sh) ENOENT$/.test(failure);
}
function isLegacyPrAutoMergeHeadBehindBaseFailure(failure: string): boolean {
  const detail = failure.toLowerCase();
  return (
    failure.startsWith("PR auto-merge failed:") &&
    /head branch is not up to date with (?:the )?base(?: branch)?/.test(detail)
  );
}
function isIgnorableLegacySuccessfulSummaryFailure(
  record: TerminalWorkOrder,
  finalSummaryPath: string,
  failure: string,
): boolean {
  return (
    isLegacyIsolatedBranchMismatchFailure(failure) ||
    isLegacySystemGitEnoentFailure(failure) ||
    isLegacyExecutableEnoentFailure(failure) ||
    isLegacyPrAutoMergeHeadBehindBaseFailure(failure) ||
    legacyPreMutationEvalFailure(record, finalSummaryPath, [failure])
  );
}
function legacyPreMutationEvalFailure(
  record: TerminalWorkOrder,
  finalSummaryPath: string,
  failures: string[],
): boolean {
  if (
    !failures.every((failure) => failure === "eval outcome is failed: deterministic-gate-failed")
  ) {
    return false;
  }
  const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
  if (parsed.ok) {
    return (
      buildEvalReportFromSupervisorSummary({
        workOrderId: record.workOrder.id,
        taskId: record.workOrder.task?.kind ?? "architecture",
        summary: parsed.summary,
      }).outcome.status === "passed"
    );
  }
  const summary = readJson(finalSummaryPath);
  const reviewGate = isRecord(summary?.reviewGate) ? summary.reviewGate : null;
  const deterministicGates = Array.isArray(reviewGate?.deterministicGates)
    ? reviewGate.deterministicGates
    : [];
  const failedGates = deterministicGates.filter(
    (gate) => isRecord(gate) && gate.result === "failed",
  );
  return failedGates.length > 0 && failedGates.every((gate) => isPreMutationDependencyGate(gate));
}
function isRestartRecoveredActiveDelegationInvalidOutput(record: TerminalWorkOrder): boolean {
  if (record.workOrder.task?.kind !== "active-delegated-task") return false;
  return (record.state.revisionReasons ?? []).some(
    (reason) =>
      reason === "supervisor worker lease has no live worker session after restart" ||
      reason === "supervisor worker lease has no active queue turn after restart",
  );
}
function readSummaryEvidence(runDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, "supervisor-summary.json"), "utf8")) as {
      result?: { reason?: unknown; output?: unknown };
    };
    return [parsed.result?.reason, parsed.result?.output]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  } catch {
    return "";
  }
}
function dependencyCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.includes("node_modules") ||
    normalized.includes(".venv/bin/") ||
    normalized.includes("venv/bin/") ||
    normalized.includes("vendor/bin/")
  );
}
function failedDependencyGate(gate: LoopSupervisorReviewGateDeterministicGate): boolean {
  const normalized = (
    typeof gate === "string"
      ? gate
      : [gate.name, gate.command, gate.evidence].filter(Boolean).join("\n")
  ).toLowerCase();
  return (
    (typeof gate === "string" ? normalized.includes("failed") : gate.result === "failed") &&
    normalized.includes("preflight") &&
    /node_modules|\.venv|npm|pnpm|yarn|vite|vitest|eslint|prettier|pytest|ruff|pyright/.test(
      normalized,
    )
  );
}
