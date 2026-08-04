import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { classifyAgentTransientFailure } from "../agents/transient-failure.js";
import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import { readLoopSupervisorWorkerLeaseState } from "../loop/supervisor-pool.js";
import { listTerminalLoopSupervisorWorkOrders } from "../loop/supervisor-state.js";
import {
  type LoopSupervisorReviewGateDeterministicGate,
  parseSupervisorFinalSummaryFile,
} from "../loop/work-order.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";
import { buildRuntimeGuardianRepairPrompt } from "../prompts/repair-prompts.js";

const log = createLogger("runtime-guardian");

export { buildRuntimeGuardianRepairPrompt };

export type RuntimeGuardianFindingKind =
  | "missing-system-gate"
  | "failed-eval-outcome"
  | "terminal-invalid-output"
  | "terminal-agent-transient-failure"
  | "terminal-work-order-active-lease"
  | "read-only-smoke-preflight-blocked";

export type RuntimeGuardianFinding = {
  kind: RuntimeGuardianFindingKind;
  severity: "medium" | "high";
  runId: string;
  projectId: string;
  projectPath: string;
  evidence: string[];
  runDir?: string;
};

export type RuntimeGuardianTickResult =
  | { fired: false; reason: "disabled" | "no-findings" | "cooldown" }
  | {
      fired: true;
      mode: AppConfig["runtimeGuardian"]["mode"];
      findings: RuntimeGuardianFinding[];
      repairDispatch: "observe-only" | "queued" | "blocked" | "unavailable" | "failed";
      detail: string;
    };

export type RuntimeGuardianRepairDispatch = (input: {
  repoPath: string;
  repairBranch: string;
  mode: AppConfig["runtimeGuardian"]["mode"];
  findings: RuntimeGuardianFinding[];
}) => Promise<RuntimeGuardianRepairDispatchResult | undefined>;

export type RuntimeGuardianRepairDispatchResult =
  | { status: "queued"; detail: string }
  | { status: "blocked"; detail: string };

export type RuntimeGuardianFindingDiscovery = () => RuntimeGuardianFinding[];
export type RuntimeGuardianRepairReadinessCheck = (
  repoPath: string,
  opts?: {
    repairBranch: string;
    worktreeIsolation: AppConfig["runtimeGuardian"]["worktreeIsolation"];
  },
) => { ok: true } | { ok: false; reason: string };

export class RuntimeGuardianStore {
  private readonly handled = new JsonMapStore<number>("runtime_guardian_handled_findings.json");

  lastHandledAt(fingerprint: string): number | undefined {
    return this.handled.get(fingerprint);
  }

  markHandled(fingerprint: string, now: number): void {
    this.handled.set(fingerprint, now);
  }

  lastRepairAttemptAt(repoPath: string): number | undefined {
    return this.handled.get(repairAttemptKey(repoPath));
  }

  markRepairAttempt(repoPath: string, now: number): void {
    this.handled.set(repairAttemptKey(repoPath), now);
  }
}

export async function runRuntimeGuardianTick(input: {
  now: number;
  config: AppConfig["runtimeGuardian"];
  store?: RuntimeGuardianStore;
  discover?: RuntimeGuardianFindingDiscovery;
  dispatchRepair?: RuntimeGuardianRepairDispatch;
  checkRepairReadiness?: RuntimeGuardianRepairReadinessCheck;
}): Promise<RuntimeGuardianTickResult> {
  if (!input.config.enabled || input.config.tickMs === 0) {
    return { fired: false, reason: "disabled" };
  }

  const store = input.store ?? new RuntimeGuardianStore();
  const discovered = (
    input.discover ??
    (() =>
      discoverRuntimeGuardianFindings({
        now: input.now,
        lookbackMs: input.config.lookbackMs,
      }))
  )();
  const findings = discovered
    .filter((finding) => !isCoolingDown(store, finding, input.now, input.config.cooldownMs))
    .slice(0, input.config.maxFindingsPerTick);

  if (findings.length === 0) {
    return { fired: false, reason: discovered.length > 0 ? "cooldown" : "no-findings" };
  }
  if (input.config.mode === "observe") {
    for (const finding of findings) store.markHandled(fingerprintForFinding(finding), input.now);
    log.warn("runtime guardian observed findings", {
      data: { findings: findings.map(loggableFinding) },
    });
    return {
      fired: true,
      mode: input.config.mode,
      findings,
      repairDispatch: "observe-only",
      detail: "observe mode records findings without delegating repair",
    };
  }

  const repoPath = runtimeGuardianRepoPath(input.config);
  const repairAttemptAt = store.lastRepairAttemptAt(repoPath);
  if (
    repairAttemptAt !== undefined &&
    input.now - repairAttemptAt >= 0 &&
    input.now - repairAttemptAt < input.config.cooldownMs
  ) {
    return { fired: false, reason: "cooldown" };
  }

  if (input.dispatchRepair === undefined) {
    return {
      fired: true,
      mode: input.config.mode,
      findings,
      repairDispatch: "unavailable",
      detail: "repair dispatch is unavailable",
    };
  }

  const worktreeIsolation = runtimeGuardianRepairWorktreeIsolation(input.config);
  const readiness = (input.checkRepairReadiness ?? checkRuntimeGuardianRepairReadiness)(repoPath, {
    repairBranch: input.config.repairBranch,
    worktreeIsolation,
  });
  if (!readiness.ok) {
    log.warn("runtime guardian repair blocked by readiness check", {
      data: { reason: readiness.reason, repoPath, findings: findings.map(loggableFinding) },
    });
    store.markRepairAttempt(repoPath, input.now);
    for (const finding of findings) store.markHandled(fingerprintForFinding(finding), input.now);
    return {
      fired: true,
      mode: input.config.mode,
      findings,
      repairDispatch: "blocked",
      detail: readiness.reason,
    };
  }

  try {
    const dispatch = await input.dispatchRepair({
      repoPath,
      repairBranch: input.config.repairBranch,
      mode: input.config.mode,
      findings,
    });
    store.markRepairAttempt(repoPath, input.now);
    for (const finding of findings) store.markHandled(fingerprintForFinding(finding), input.now);
    if (dispatch?.status === "blocked") {
      log.warn("runtime guardian repair delegation blocked", {
        data: { detail: dispatch.detail, findings: findings.map(loggableFinding) },
      });
      return {
        fired: true,
        mode: input.config.mode,
        findings,
        repairDispatch: "blocked",
        detail: dispatch.detail,
      };
    }
    const detail = dispatch?.detail ?? "queued";
    log.warn("runtime guardian delegated repair", {
      data: { detail, findings: findings.map(loggableFinding) },
    });
    return {
      fired: true,
      mode: input.config.mode,
      findings,
      repairDispatch: "queued",
      detail,
    };
  } catch (err) {
    log.warn("runtime guardian repair delegation failed", { err });
    return {
      fired: true,
      mode: input.config.mode,
      findings,
      repairDispatch: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function discoverRuntimeGuardianFindings(
  input: { now: number; lookbackMs: number } = { now: Date.now(), lookbackMs: 86_400_000 },
): RuntimeGuardianFinding[] {
  const findings: RuntimeGuardianFinding[] = [];
  const terminal = listTerminalLoopSupervisorWorkOrders();

  for (const record of terminal) {
    if (isOutsideLookback(record.state.updatedAt, input.now, input.lookbackMs)) continue;
    const gatePath = join(record.runDir, "system-gate.json");
    const finalSummaryPath =
      record.workOrder.finalSummaryPath ?? join(record.runDir, "supervisor-final-summary.json");
    const failedEvalOutcome = failedEvalOutcomeFinding(record, gatePath);
    if (failedEvalOutcome !== null) findings.push(failedEvalOutcome);
    if (
      record.state.status === "completed" &&
      existsSync(finalSummaryPath) &&
      !existsSync(gatePath)
    ) {
      findings.push({
        kind: "missing-system-gate",
        severity: "high",
        runId: record.workOrder.id,
        projectId: record.workOrder.projectId,
        projectPath: record.workOrder.projectPath,
        runDir: record.runDir,
        evidence: [
          `terminal completed work-order exists: ${record.workOrder.id}`,
          `supervisor final summary exists: ${finalSummaryPath}`,
          `system gate evidence is missing: ${gatePath}`,
        ],
      });
    }
    if (
      record.state.status === "failed" &&
      record.state.resultStatus === "invalid-output" &&
      !parseSupervisorFinalSummaryFile(record.workOrder).ok
    ) {
      findings.push({
        kind: "terminal-invalid-output",
        severity: "medium",
        runId: record.workOrder.id,
        projectId: record.workOrder.projectId,
        projectPath: record.workOrder.projectPath,
        runDir: record.runDir,
        evidence: [
          `terminal failed work-order has resultStatus=invalid-output: ${record.workOrder.id}`,
          `runDir: ${record.runDir}`,
        ],
      });
    }
    const agentTransientFailure = terminalAgentTransientFailureFinding(record);
    if (agentTransientFailure !== null) findings.push(agentTransientFailure);
    const readOnlySmokePreflightBlocked = readOnlySmokePreflightBlockedFinding(
      record,
      finalSummaryPath,
    );
    if (readOnlySmokePreflightBlocked !== null) {
      findings.push(readOnlySmokePreflightBlocked);
    }
  }

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

function failedEvalOutcomeFinding(
  record: ReturnType<typeof listTerminalLoopSupervisorWorkOrders>[number],
  gatePath: string,
): RuntimeGuardianFinding | null {
  if (record.state.status !== "completed" || !existsSync(gatePath)) return null;
  const parsed = readJsonRecord(gatePath);
  const evalReport = parsed?.evalReport;
  if (!isRecord(evalReport)) return null;
  const outcome = evalReport.outcome;
  if (!isRecord(outcome)) return null;
  const status = typeof outcome.status === "string" ? outcome.status : null;
  if (status === null || status === "passed") return null;
  const reason = typeof outcome.reason === "string" ? outcome.reason : "no reason recorded";

  return {
    kind: "failed-eval-outcome",
    severity: "high",
    runId: record.workOrder.id,
    projectId: record.workOrder.projectId,
    projectPath: record.workOrder.projectPath,
    runDir: record.runDir,
    evidence: [
      `system gate eval outcome is ${status}: ${reason}`,
      `system gate evidence exists: ${gatePath}`,
    ],
  };
}

function readJsonRecord(path: string): Record<string, unknown> | null {
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

function terminalAgentTransientFailureFinding(
  record: ReturnType<typeof listTerminalLoopSupervisorWorkOrders>[number],
): RuntimeGuardianFinding | null {
  if (record.state.status !== "failed" || record.state.resultStatus !== "dispatch-failed") {
    return null;
  }
  const evidenceText = [
    ...(record.state.revisionReasons ?? []),
    readSupervisorSummaryEvidence(record.runDir),
  ]
    .filter(Boolean)
    .join("\n");
  const transient = classifyAgentTransientFailure(evidenceText);
  if (transient === null) return null;
  return {
    kind: "terminal-agent-transient-failure",
    severity: "medium",
    runId: record.workOrder.id,
    projectId: record.workOrder.projectId,
    projectPath: record.workOrder.projectPath,
    runDir: record.runDir,
    evidence: [
      `terminal failed work-order has retryable agent transient failure: ${record.workOrder.id}`,
      `transient-kind: ${transient.kind}`,
      evidenceText,
    ],
  };
}

function readSupervisorSummaryEvidence(runDir: string): string {
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

function readOnlySmokePreflightBlockedFinding(
  record: ReturnType<typeof listTerminalLoopSupervisorWorkOrders>[number],
  finalSummaryPath: string,
): RuntimeGuardianFinding | null {
  if (record.state.status !== "failed" || record.state.resultStatus !== "blocked") return null;
  if (record.workOrder.task?.kind !== "active-delegated-task") return null;
  if (!isReadOnlySmokeRequirement(record.workOrder.task.requirement)) return null;
  if (hasDependencyOnlyPreflight(record.workOrder)) return null;

  const parsed = parseSupervisorFinalSummaryFile(record.workOrder);
  if (!parsed.ok || parsed.summary.status !== "blocked") return null;
  const failedPreflight = parsed.summary.reviewGate?.deterministicGates.find(
    isFailedDependencyPreflightGate,
  );
  if (failedPreflight === undefined) return null;

  return {
    kind: "read-only-smoke-preflight-blocked",
    severity: "medium",
    runId: record.workOrder.id,
    projectId: record.workOrder.projectId,
    projectPath: record.workOrder.projectPath,
    runDir: record.runDir,
    evidence: [
      `read-only smoke active delegation blocked by target dependency preflight: ${record.workOrder.id}`,
      `supervisor final summary exists: ${finalSummaryPath}`,
      `failed gate: ${describeDeterministicGate(failedPreflight)}`,
      "This points to tmux-claude-bot verification-profile/worktree-policy behavior, not a target-project repair.",
    ],
  };
}

function isReadOnlySmokeRequirement(requirement: string): boolean {
  const normalized = requirement.toLowerCase();
  return normalized.includes("read-only") && normalized.includes("smoke");
}

function hasDependencyOnlyPreflight(
  workOrder: ReturnType<typeof listTerminalLoopSupervisorWorkOrders>[number]["workOrder"],
): boolean {
  const commands = workOrder.preflight.commands;
  return commands.length > 0 && commands.every((command) => dependencyPreflightCommand(command));
}

function isFailedDependencyPreflightGate(gate: LoopSupervisorReviewGateDeterministicGate): boolean {
  if (typeof gate === "string") {
    const normalized = gate.toLowerCase();
    return (
      normalized.includes("failed") &&
      normalized.includes("preflight") &&
      dependencyEvidencePattern().test(normalized)
    );
  }
  if (gate.result !== "failed") return false;
  const normalized = [gate.name, gate.command, gate.evidence]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return normalized.includes("preflight") && dependencyEvidencePattern().test(normalized);
}

function dependencyPreflightCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.includes("node_modules") ||
    normalized.includes(".venv/bin/") ||
    normalized.includes("venv/bin/") ||
    normalized.includes("vendor/bin/")
  );
}

function dependencyEvidencePattern(): RegExp {
  return /node_modules|\.venv|npm|pnpm|yarn|vite|vitest|eslint|prettier|pytest|ruff|pyright/;
}

function describeDeterministicGate(gate: LoopSupervisorReviewGateDeterministicGate): string {
  if (typeof gate === "string") return gate;
  return [gate.name, gate.result, gate.evidence].filter(Boolean).join(" | ");
}

export function checkRuntimeGuardianRepairReadiness(
  repoPath: string,
  opts?: {
    repairBranch: string;
    worktreeIsolation: AppConfig["runtimeGuardian"]["worktreeIsolation"];
  },
): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync("git", ["-C", repoPath, "status", "--porcelain"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `cannot verify clean git worktree for runtime guardian repo: ${
        result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`
      }`,
    };
  }
  if (result.stdout.trim().length > 0) {
    return {
      ok: false,
      reason:
        "runtime guardian repo has uncommitted changes; self-repair waits for a clean worktree",
    };
  }
  if (opts?.worktreeIsolation === "source") {
    const branch = spawnSync("git", ["-C", repoPath, "branch", "--show-current"], {
      encoding: "utf8",
    });
    if (branch.status !== 0) {
      return {
        ok: false,
        reason: `cannot verify runtime guardian source branch: ${
          branch.stderr.trim() || branch.stdout.trim() || `exit ${branch.status ?? "unknown"}`
        }`,
      };
    }
    const currentBranch = branch.stdout.trim();
    if (currentBranch !== opts.repairBranch) {
      return {
        ok: false,
        reason: `runtime guardian source repair requires branch ${opts.repairBranch}; current branch is ${currentBranch || "<detached>"}`,
      };
    }
  }
  return { ok: true };
}

export async function dispatchRuntimeGuardianRepair(
  deps: HandlerDeps,
  request: Parameters<RuntimeGuardianRepairDispatch>[0],
): Promise<RuntimeGuardianRepairDispatchResult> {
  if (!deps.config.loopEngineering.supervisor.enabled) {
    log.warn("runtime guardian repair skipped because loop supervisor is disabled");
    return { status: "blocked", detail: "loop supervisor is disabled" };
  }
  const session = sessionNameFromPath(request.repoPath, deps.config.projectSessionPrefix);
  setPathForSession(session, request.repoPath);
  const result = await startActiveDelegatedTask(deps, {
    session,
    requirement: buildRuntimeGuardianRepairPrompt(request),
    worktreeIsolation: runtimeGuardianRepairWorktreeIsolation(deps.config.runtimeGuardian),
  });
  if (result.status === "blocked") {
    return { status: "blocked", detail: result.reason };
  }
  return {
    status: "queued",
    detail: `runId=${result.runId} project=${result.projectId} supervisor=${result.supervisorSession}`,
  };
}

function runtimeGuardianRepairWorktreeIsolation(
  config: AppConfig["runtimeGuardian"],
): AppConfig["runtimeGuardian"]["worktreeIsolation"] {
  if (config.worktreeIsolation !== "auto") return config.worktreeIsolation;
  return config.mode === "fast-heal" ? "source" : "isolated";
}

export function startRuntimeGuardian(deps: HandlerDeps): () => void {
  const config = deps.config.runtimeGuardian;
  if (!config.enabled || config.tickMs === 0) {
    log.info("runtime guardian disabled");
    return () => {};
  }
  const tick = (): void => {
    void runRuntimeGuardianTick({
      now: Date.now(),
      config,
      dispatchRepair: (request) => dispatchRuntimeGuardianRepair(deps, request),
    }).catch((err) => log.warn("runtime guardian tick failed", { err }));
  };
  const timer = setInterval(tick, config.tickMs);
  (timer as { unref?: () => void }).unref?.();
  void tick();
  log.info("runtime guardian started", {
    data: {
      mode: config.mode,
      tickMs: config.tickMs,
      lookbackMs: config.lookbackMs,
      cooldownMs: config.cooldownMs,
      repoPath: runtimeGuardianRepoPath(config),
      repairBranch: config.repairBranch,
    },
  });
  return () => clearInterval(timer);
}

function runtimeGuardianRepoPath(config: AppConfig["runtimeGuardian"]): string {
  return resolve(config.repoPath || process.cwd());
}

function isCoolingDown(
  store: RuntimeGuardianStore,
  finding: RuntimeGuardianFinding,
  now: number,
  cooldownMs: number,
): boolean {
  if (cooldownMs === 0) return false;
  const last = store.lastHandledAt(fingerprintForFinding(finding));
  return last !== undefined && now - last < cooldownMs;
}

function isOutsideLookback(updatedAt: number, now: number, lookbackMs: number): boolean {
  return lookbackMs > 0 && now - updatedAt > lookbackMs;
}

function fingerprintForFinding(finding: RuntimeGuardianFinding): string {
  return `${finding.kind}:${finding.projectId}:${finding.runId}`;
}

function repairAttemptKey(repoPath: string): string {
  return `__repair-attempt__:${repoPath}`;
}

function loggableFinding(finding: RuntimeGuardianFinding): Record<string, unknown> {
  return {
    kind: finding.kind,
    severity: finding.severity,
    projectId: finding.projectId,
    runId: finding.runId,
    runDir: finding.runDir,
  };
}
