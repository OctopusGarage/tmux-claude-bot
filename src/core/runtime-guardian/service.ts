import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AppConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import {
  reconcileLoopSupervisorWorkOrders,
  runGitCommand,
  runShellCommand,
} from "../loop/service.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";
import { buildRuntimeGuardianRepairPrompt } from "../prompts/repair-prompts.js";
import { cleanupWorkerSessionRecords } from "../recovery/worker-session-cleanup.js";
import { admitRecoveryFindings } from "../tasks/recovery-admission.js";
import { RepairCoordinator } from "../tasks/repair-coordinator.js";
import { reconcileAutopilotDelegatedTasks } from "../tasks/task-reconciliation.js";
import type { RuntimeGuardianFinding } from "./findings.js";
import { discoverRuntimeGuardianFindings } from "./inspector.js";
import {
  dueRuntimeGuardianFindings,
  isTargetOrExternalBlocker,
  reconcileRuntimeGuardianQueue,
} from "./queue-reconciliation.js";

const log = createLogger("runtime-guardian");

export { buildRuntimeGuardianRepairPrompt, discoverRuntimeGuardianFindings };

type LoopSupervisorReconcileInput = Parameters<typeof reconcileLoopSupervisorWorkOrders>[0];

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
  reconcile?: () => Promise<void> | void;
  coordinator?: RepairCoordinator;
}): Promise<RuntimeGuardianTickResult> {
  if (!input.config.enabled || input.config.tickMs === 0) {
    return { fired: false, reason: "disabled" };
  }
  await input.reconcile?.();

  const store = input.store ?? new RuntimeGuardianStore();
  const discovered = (
    input.discover ??
    (() =>
      discoverRuntimeGuardianFindings({
        now: input.now,
        lookbackMs: input.config.lookbackMs,
        repoPath: runtimeGuardianRepoPath(input.config),
      }))
  )();
  const coordinator = input.coordinator ?? new RepairCoordinator();
  coordinator.reconcileDuplicateTaskIds(input.now);
  reconcileRuntimeGuardianQueue({ coordinator, now: input.now, findings: discovered });
  const rediscoverable = discovered.filter(
    (finding) => !hasTerminalRuntimeGuardianRecord(coordinator, finding),
  );
  const due = dueRuntimeGuardianFindings({
    coordinator,
    now: input.now,
    limit: input.config.maxFindingsPerTick,
  });
  const dueKeys = new Set(due.map(runtimeFindingKey));
  const findings = [
    ...due,
    ...rediscoverable.filter(
      (finding) =>
        !dueKeys.has(runtimeFindingKey(finding)) &&
        !isCoolingDown(store, finding, input.now, input.config.cooldownMs),
    ),
  ].slice(0, input.config.maxFindingsPerTick);

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

  const repairableFindings = findings.filter((finding) => !isTargetOrExternalBlocker(finding));
  const nonRepairableFindings = findings.filter(isTargetOrExternalBlocker);
  for (const finding of nonRepairableFindings) {
    store.markHandled(fingerprintForFinding(finding), input.now);
  }
  if (repairableFindings.length === 0) {
    return {
      fired: true,
      mode: input.config.mode,
      findings,
      repairDispatch: "blocked",
      detail: "findings are target or external blockers; no bot self-repair dispatched",
    };
  }

  const repoPath = runtimeGuardianRepoPath(input.config);
  const repairAttemptAt = store.lastRepairAttemptAt(repoPath);
  if (
    due.length === 0 &&
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
      findings: repairableFindings,
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
      data: {
        reason: readiness.reason,
        repoPath,
        findings: repairableFindings.map(loggableFinding),
      },
    });
    return {
      fired: true,
      mode: input.config.mode,
      findings: repairableFindings,
      repairDispatch: "blocked",
      detail: readiness.reason,
    };
  }

  try {
    const dispatch = await input.dispatchRepair({
      repoPath,
      repairBranch: input.config.repairBranch,
      mode: input.config.mode,
      findings: repairableFindings,
    });
    store.markRepairAttempt(repoPath, input.now);
    for (const finding of findings) store.markHandled(fingerprintForFinding(finding), input.now);
    if (dispatch?.status === "blocked") {
      const ctx = {
        data: { detail: dispatch.detail, findings: repairableFindings.map(loggableFinding) },
      };
      if (isTransientRepairAdmissionDeferral(dispatch.detail)) {
        log.debug("runtime guardian repair delegation blocked", ctx);
      } else {
        log.warn("runtime guardian repair delegation blocked", ctx);
      }
      return {
        fired: true,
        mode: input.config.mode,
        findings: repairableFindings,
        repairDispatch: "blocked",
        detail: dispatch.detail,
      };
    }
    const detail = dispatch?.detail ?? "queued";
    log.warn("runtime guardian delegated repair", {
      data: { detail, findings: repairableFindings.map(loggableFinding) },
    });
    return {
      fired: true,
      mode: input.config.mode,
      findings: repairableFindings,
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

function isTransientRepairAdmissionDeferral(detail: string): boolean {
  return /^(automation admission deferred:|project already has active automation:|supervisor .*busy|supervisor .*lease|queue full|no available)/i.test(
    detail,
  );
}

export async function reconcileRuntimeGuardianBeforeDiscovery(
  input: Pick<
    LoopSupervisorReconcileInput,
    | "configFile"
    | "now"
    | "runCommand"
    | "runGit"
    | "cleanupCompletedWorkerSession"
    | "workerSessionExists"
  > & {
    reconcileAutopilot?: typeof reconcileAutopilotDelegatedTasks;
    reconcileLoop?: typeof reconcileLoopSupervisorWorkOrders;
  },
): Promise<void> {
  const cleanupWorkerSession = input.cleanupCompletedWorkerSession ?? (async () => undefined);
  await (input.reconcileAutopilot ?? reconcileAutopilotDelegatedTasks)({
    cleanupWorkerSession,
  });
  await (input.reconcileLoop ?? reconcileLoopSupervisorWorkOrders)({
    configFile: input.configFile,
    now: input.now,
    runCommand: input.runCommand,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
    cleanupCompletedWorkerSession: cleanupWorkerSession,
    ...(input.workerSessionExists === undefined
      ? {}
      : { workerSessionExists: input.workerSessionExists }),
  });
}

function runtimeFindingKey(finding: RuntimeGuardianFinding): string {
  return `${finding.kind}|${finding.projectId}|${finding.runId}`;
}

function hasTerminalRuntimeGuardianRecord(
  coordinator: RepairCoordinator,
  finding: RuntimeGuardianFinding,
): boolean {
  return coordinator
    .list()
    .some(
      (record) =>
        record.source === "runtime-guardian" &&
        record.projectId === finding.projectId &&
        record.taskFamily === finding.kind &&
        record.linkedTaskIds.includes(finding.runId) &&
        TERMINAL_RUNTIME_GUARDIAN_REPAIR_STATUSES.has(record.status),
    );
}

const TERMINAL_RUNTIME_GUARDIAN_REPAIR_STATUSES = new Set([
  "fixed",
  "blocked",
  "not-reproducible",
  "superseded",
  "dead-letter",
]);

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
  const now = Date.now();
  const coordinator = new RepairCoordinator();
  const leaseId = `runtime-guardian:${now}`;
  let delegated: Awaited<ReturnType<typeof startActiveDelegatedTask>> | undefined;
  const admission = await admitRecoveryFindings({
    findings: request.findings.map((finding) => ({
      projectId: finding.projectId,
      projectPath: finding.projectPath,
      source: "runtime-guardian",
      taskFamily: finding.kind,
      fingerprint: finding.evidence.join(" | "),
      taskId: finding.runId,
      summary: finding.evidence.join("; "),
      priority: finding.severity === "high" ? 100 : 50,
      ...(isTargetOrExternalBlocker(finding) ? { terminalStatus: "blocked" as const } : {}),
    })),
    coordinator,
    now,
    leaseId,
    dispatch: async () => {
      delegated = await startActiveDelegatedTask(deps, {
        session,
        requirement: buildRuntimeGuardianRepairPrompt(request),
        worktreeIsolation: runtimeGuardianRepairWorktreeIsolation(deps.config.runtimeGuardian),
        resourceTrigger: "background",
      });
      return delegated.status === "blocked"
        ? {
            status: "blocked",
            detail: delegated.reason,
            ...(delegated.retryAt === undefined ? {} : { retryAt: delegated.retryAt }),
          }
        : {
            status: "queued",
            detail: `runId=${delegated.runId} project=${delegated.projectId} supervisor=${delegated.supervisorSession}`,
          };
    },
  });
  if (
    admission.disposition !== "queued" ||
    delegated === undefined ||
    delegated.status === "blocked"
  ) {
    return { status: "blocked", detail: admission.detail };
  }
  for (const record of coordinator
    .list()
    .filter(
      (record) =>
        record.source === "runtime-guardian" &&
        record.status === "running" &&
        record.leaseId === leaseId,
    )) {
    coordinator.attachWorkOrder(record.id, delegated.runId, now);
    coordinator.linkTaskIds(record.id, [`autopilot:${delegated.runId}`], now);
  }
  return {
    status: "queued",
    detail: admission.detail,
  };
}

function runtimeGuardianRepairWorktreeIsolation(
  config: AppConfig["runtimeGuardian"],
): AppConfig["runtimeGuardian"]["worktreeIsolation"] {
  if (config.worktreeIsolation !== "auto") return config.worktreeIsolation;
  return config.mode === "fast-heal" ? "source" : "isolated";
}

export function startRuntimeGuardian(
  deps: HandlerDeps,
  options: {
    now?: () => number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    runTick?: typeof runRuntimeGuardianTick;
    reconcileBeforeDiscovery?: typeof reconcileRuntimeGuardianBeforeDiscovery;
  } = {},
): () => void {
  const config = deps.config.runtimeGuardian;
  if (!config.enabled || config.tickMs === 0) {
    log.info("runtime guardian disabled");
    return () => {};
  }
  const now = options.now ?? Date.now;
  const tick = (): void => {
    void (options.runTick ?? runRuntimeGuardianTick)({
      now: now(),
      config,
      dispatchRepair: (request) => dispatchRuntimeGuardianRepair(deps, request),
      reconcile: async () => {
        await (options.reconcileBeforeDiscovery ?? reconcileRuntimeGuardianBeforeDiscovery)({
          configFile: deps.config.loopEngineering.configFile,
          now: now(),
          runCommand: runShellCommand,
          runGit: runGitCommand,
          cleanupCompletedWorkerSession: async (session) => {
            await deps.bridge.killSession(session);
            cleanupWorkerSessionRecords(session);
          },
          workerSessionExists: (session) => deps.bridge.hasSession(session),
        });
      },
    }).catch((err) => log.warn("runtime guardian tick failed", { err }));
  };
  const timer = (options.setInterval ?? setInterval)(tick, config.tickMs);
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
  return () => (options.clearInterval ?? clearInterval)(timer);
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
