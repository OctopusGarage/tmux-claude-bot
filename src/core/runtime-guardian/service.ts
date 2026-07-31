import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import { readLoopSupervisorWorkerLeaseState } from "../loop/supervisor-pool.js";
import { listTerminalLoopSupervisorWorkOrders } from "../loop/supervisor-state.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";

const log = createLogger("runtime-guardian");
const DEFAULT_REPAIR_REQUIREMENT_SOURCE = "runtime-guardian";

export type RuntimeGuardianFindingKind =
  | "missing-system-gate"
  | "terminal-invalid-output"
  | "terminal-work-order-active-lease";

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

  const readiness = (input.checkRepairReadiness ?? checkRuntimeGuardianRepairReadiness)(repoPath);
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
    if (record.state.status === "failed" && record.state.resultStatus === "invalid-output") {
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

export function checkRuntimeGuardianRepairReadiness(
  repoPath: string,
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
  });
  if (result.status === "blocked") {
    return { status: "blocked", detail: result.reason };
  }
  return {
    status: "queued",
    detail: `runId=${result.runId} project=${result.projectId} supervisor=${result.supervisorSession}`,
  };
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

export function buildRuntimeGuardianRepairPrompt(input: {
  repoPath: string;
  repairBranch: string;
  mode: AppConfig["runtimeGuardian"]["mode"];
  findings: RuntimeGuardianFinding[];
}): string {
  return [
    `Runtime Guardian (${input.mode}) found confirmed tmux-claude-bot runtime issue(s).`,
    `Repository: ${input.repoPath}`,
    `Base branch: ${input.repairBranch}`,
    "",
    "Scope:",
    "- Fix tmux-claude-bot system-layer/runtime orchestration issues only.",
    "- Do not edit target project repositories mentioned in findings.",
    "- Prioritize scheduler correctness, supervisor/worker state, system gates, notifications, launchd/dev-service behavior, and task-audit reporting.",
    "- Before editing, re-check the evidence and prove the issue is real; if not real, make no changes.",
    "- Before editing, write a pre-mutation review in the supervisor final summary reviewGate: confirmed finding, affected system path, reachability, scope boundary, and why a tmux-claude-bot code/config change is justified.",
    "- Fix narrowly, add or update a focused regression test when practical, run relevant verification, inspect the diff, and commit only verified fixes.",
    "- After editing, write a post-mutation review in reviewGate: diff reviewed, original runtime failure path addressed, regression/security/scheduler/state/notification/PR-gate risks checked, and deterministic gates run.",
    "- AI review/eval may be used only through the existing Claude Code / Codex control surface. It is advisory; deterministic gates and system acceptance remain authoritative.",
    "- Use CodeGraph before grep/find when .codegraph exists. Read AGENTS.md and CLAUDE.md before code changes.",
    "- Do not open a PR; the supervisor/system layer handles PR and merge gates.",
    "",
    "Findings:",
    JSON.stringify(input.findings, null, 2),
    "",
    `source=${DEFAULT_REPAIR_REQUIREMENT_SOURCE}`,
  ].join("\n");
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
