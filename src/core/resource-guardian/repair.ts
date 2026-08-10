import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { readLoopSupervisorWorkOrderRegistry } from "../loop/supervisor-state.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";
import { buildResourceGuardianRepairPrompt } from "../prompts/repair-prompts.js";
import { RepairCoordinator } from "../tasks/repair-coordinator.js";
import type { ResourceGuardianStore } from "./store.js";
import type { PressureState, ResourceCircuitAdmission, ResourceIncident } from "./types.js";

export const RESOURCE_REPAIR_STABLE_MS = 10 * 60_000;
export const RESOURCE_REPAIR_MAX_ATTEMPTS = 3;

export type ResourceRepairQueueState = {
  hasActiveFingerprintRepair: boolean;
  hasActiveResourceRepair: boolean;
  cooldownActive: boolean;
  retryExhausted: boolean;
  workOrderId?: string;
};

/** Settle Resource Guardian queue records from the authoritative terminal WorkOrder registry. */
export function reconcileResourceGuardianRepairQueue(input: {
  coordinator: RepairCoordinator;
  now: number;
  readRegistry?: typeof readLoopSupervisorWorkOrderRegistry;
}): void {
  const registry = (input.readRegistry ?? readLoopSupervisorWorkOrderRegistry)();
  const terminalByRunId = new Map(
    registry.terminal.map((record) => [record.workOrder.id, record.state.status]),
  );
  for (const record of input.coordinator.list()) {
    if (
      record.source !== "resource-guardian" ||
      (record.status !== "leased" && record.status !== "running") ||
      record.workOrderId === undefined
    )
      continue;
    const terminalStatus = terminalByRunId.get(record.workOrderId);
    if (terminalStatus === undefined) continue;
    input.coordinator.markTerminal(
      record.id,
      terminalStatus === "completed" ? "fixed" : "blocked",
      input.now,
    );
  }
}

export function resourceRepairQueueState(
  coordinator: RepairCoordinator,
  fingerprint: string,
  now: number,
): ResourceRepairQueueState {
  const allRecords = coordinator.list();
  const records = allRecords.filter((record) => record.source === "resource-guardian");
  const matching = records.filter((record) => record.fingerprint === fingerprint);
  const activeFingerprint = (record: (typeof records)[number]) =>
    record.status === "pending" || record.status === "leased" || record.status === "running";
  const activeGlobal = (record: (typeof allRecords)[number]) =>
    record.status === "leased" || record.status === "running";
  const retry = matching.filter((record) => record.status === "retry-wait");
  const latest = matching.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0];
  return {
    hasActiveFingerprintRepair: matching.some(activeFingerprint),
    hasActiveResourceRepair: allRecords.some(activeGlobal),
    cooldownActive: retry.some((record) => record.nextAttemptAt > now),
    retryExhausted: retry.some((record) => record.attempt >= RESOURCE_REPAIR_MAX_ATTEMPTS),
    ...(latest?.workOrderId === undefined ? {} : { workOrderId: latest.workOrderId }),
  };
}

export type ResourceRepairEligibilityInput = {
  now: number;
  pressure: PressureState;
  circuit: ResourceCircuitAdmission;
  stableSince: number | null;
  incident: {
    id: string;
    fingerprint: string;
    attribution: "bot-owned" | "external" | "unknown";
  } | null;
  hasRepairNeededEvidence: boolean;
  hasActiveFingerprintRepair: boolean;
  hasActiveResourceRepair: boolean;
  cooldownActive: boolean;
  retryExhausted: boolean;
};

export type ResourceRepairEligibility = { eligible: true } | { eligible: false; reason: string };

/** Select only a durably ended bot incident whose deterministic cleanup remained unresolved. */
export function selectResourceRepairCandidate(
  incidents: readonly ResourceIncident[],
): ResourceIncident | undefined {
  return incidents
    .filter(
      (incident) =>
        incident.endedAt !== undefined &&
        incident.attribution === "bot-owned" &&
        incident.repairWorkOrderId === undefined &&
        incident.actions.some(
          (action) =>
            action.kind === "resource-action" &&
            action.phase === "deterministic-cleanup" &&
            action.outcome === "failed",
        ),
    )
    .sort(
      (left, right) =>
        (right.endedAt ?? 0) - (left.endedAt ?? 0) || right.id.localeCompare(left.id),
    )[0];
}

/** Fail closed until recovery is durably stable and no repair ownership conflicts remain. */
export function resourceRepairEligibility(
  input: ResourceRepairEligibilityInput,
): ResourceRepairEligibility {
  if (input.pressure !== "healthy" || input.circuit !== "open")
    return { eligible: false, reason: "resource recovery is not healthy and open" };
  if (input.stableSince === null || input.now < input.stableSince)
    return { eligible: false, reason: "stable recovery time is unavailable" };
  if (input.now - input.stableSince < RESOURCE_REPAIR_STABLE_MS)
    return { eligible: false, reason: "stable recovery window has not elapsed" };
  if (input.incident?.attribution !== "bot-owned")
    return { eligible: false, reason: "incident is not strongly bot-owned" };
  if (!input.hasRepairNeededEvidence)
    return {
      eligible: false,
      reason: "deterministic cleanup did not leave repair-needed evidence",
    };
  if (input.hasActiveFingerprintRepair)
    return { eligible: false, reason: "an active repair already owns this incident fingerprint" };
  if (input.hasActiveResourceRepair)
    return { eligible: false, reason: "another resource guardian repair is active" };
  if (input.cooldownActive)
    return { eligible: false, reason: "resource repair cooldown is active" };
  if (input.retryExhausted)
    return { eligible: false, reason: "resource repair retry budget is exhausted" };
  return { eligible: true };
}

export type ResourceGuardianRepairDispatch = {
  status: "queued" | "blocked" | "duplicate";
  detail: string;
  queueId?: string;
  workOrderId?: string;
};

/** Reconcile durable recovery evidence and dispatch exactly one eligible repair. */
export async function dispatchStableResourceRepair(input: {
  now: number;
  pressure: PressureState;
  circuit: ResourceCircuitAdmission;
  stableSince: number | null;
  store: Pick<ResourceGuardianStore, "listIncidents" | "writeIncident">;
  dispatch: (
    incident: ResourceIncident,
    now: number,
    persistIntent?: (queueId: string) => Promise<void>,
  ) => Promise<ResourceGuardianRepairDispatch>;
  coordinator?: RepairCoordinator;
}): Promise<void> {
  if (input.coordinator !== undefined) {
    reconcileResourceGuardianRepairQueue({ coordinator: input.coordinator, now: input.now });
  }
  const incident = selectResourceRepairCandidate(input.store.listIncidents());
  const queue =
    input.coordinator === undefined
      ? {
          hasActiveFingerprintRepair: false,
          hasActiveResourceRepair: false,
          cooldownActive: false,
          retryExhausted: false,
        }
      : resourceRepairQueueState(input.coordinator, incident?.fingerprint ?? "", input.now);
  if (
    incident !== undefined &&
    incident.repairWorkOrderId === undefined &&
    queue.workOrderId !== undefined
  ) {
    const recovered = structuredClone(incident);
    recovered.repairWorkOrderId = queue.workOrderId;
    recovered.actions.push({
      kind: "resource-action",
      phase: "repair-dispatch",
      at: input.now,
      outcome: "recorded",
      reason: "repair work order recovered from durable queue",
    });
    input.store.writeIncident(recovered);
    return;
  }
  const eligibility = resourceRepairEligibility({
    now: input.now,
    pressure: input.pressure,
    circuit: input.circuit,
    stableSince: input.stableSince,
    incident: incident
      ? { id: incident.id, fingerprint: incident.fingerprint, attribution: incident.attribution }
      : null,
    hasRepairNeededEvidence: incident !== undefined,
    hasActiveFingerprintRepair: queue.hasActiveFingerprintRepair,
    hasActiveResourceRepair: queue.hasActiveResourceRepair,
    cooldownActive: queue.cooldownActive,
    retryExhausted: queue.retryExhausted,
  });
  if (!eligibility.eligible || incident === undefined) return;
  let intentIncident = incident;
  const dispatched = await input.dispatch(incident, input.now, async (queueId) => {
    const writtenIntent = structuredClone(incident);
    writtenIntent.actions.push({
      kind: "resource-action",
      phase: "repair-intent",
      at: input.now,
      outcome: "recorded",
      reason: `repair intent: ${queueId}`,
    });
    input.store.writeIncident(writtenIntent);
    intentIncident = writtenIntent;
  });
  if (dispatched.status !== "queued" || dispatched.workOrderId === undefined) return;
  const next = structuredClone(intentIncident);
  next.repairWorkOrderId = dispatched.workOrderId;
  next.actions.push({
    kind: "resource-action",
    phase: "repair-dispatch",
    at: input.now,
    outcome: "recorded",
    reason: `repair queued: ${dispatched.queueId ?? "durable queue"}`,
  });
  input.store.writeIncident(next);
}

/** Preserve dispatch failure evidence without allowing a durable-store fault to stop pressure handling. */
export function recordResourceRepairDispatchFailure(input: {
  now: number;
  reason: string;
  store: Pick<ResourceGuardianStore, "listIncidents" | "writeIncident">;
}): void {
  const incident = selectResourceRepairCandidate(input.store.listIncidents());
  if (incident === undefined) return;
  try {
    const next = structuredClone(incident);
    next.actions.push({
      kind: "resource-action",
      phase: "repair-dispatch",
      at: input.now,
      outcome: "failed",
      reason: input.reason,
    });
    input.store.writeIncident(next);
  } catch {
    // Resource pressure and transition notification must outlive repair evidence persistence.
  }
}

export async function dispatchResourceGuardianRepair(input: {
  now: number;
  repoPath: string;
  repairBranch: string;
  incident: { id: string; fingerprint: string; evidence: readonly string[] };
  coordinator: RepairCoordinator;
  gitTopLevel(path: string): Promise<string | null>;
  start(
    requirement: string,
    context: { runId: string },
  ): Promise<{ status: "queued" | "blocked"; runId?: string }>;
  prompt: string;
  persistIntent?: (queueId: string) => Promise<void>;
}): Promise<ResourceGuardianRepairDispatch> {
  const configured = resolve(input.repoPath);
  const actual = await input.gitTopLevel(configured);
  if (actual === null || resolve(actual) !== configured)
    return { status: "blocked", detail: "configured repair repository did not match git toplevel" };
  const active = input.coordinator
    .list()
    .filter((record) => record.status === "leased" || record.status === "running");
  if (active.length > 0)
    return { status: "duplicate", detail: "an active resource guardian repair already exists" };
  const retry = input.coordinator
    .list()
    .find(
      (record) =>
        record.source === "resource-guardian" &&
        record.fingerprint === input.incident.fingerprint &&
        record.status === "retry-wait",
    );
  if (retry !== undefined && retry.attempt >= RESOURCE_REPAIR_MAX_ATTEMPTS)
    return { status: "blocked", detail: "resource repair retry budget is exhausted" };
  if (retry !== undefined && retry.nextAttemptAt > input.now)
    return { status: "blocked", detail: "resource repair cooldown is active" };
  const record =
    retry ??
    input.coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: configured,
      source: "resource-guardian",
      taskFamily: "resource-guardian-stable-recovery",
      fingerprint: input.incident.fingerprint,
      taskId: input.incident.id,
      summary: input.incident.evidence.join("; "),
      priority: 100,
      now: input.now,
    });
  const leaseId = `resource-guardian:${input.incident.id}`;
  const claimed = input.coordinator.claimIds([record.id], { now: input.now, leaseId, limit: 1 });
  if (claimed.length !== 1) return { status: "duplicate", detail: "repair was not claimable" };
  const running = input.coordinator.markRunning(record.id, leaseId, input.now);
  if (running === undefined)
    return { status: "blocked", detail: "repair could not be marked running" };
  try {
    await input.persistIntent?.(record.id);
  } catch {
    input.coordinator.releaseForRetry(record.id, input.now);
    return { status: "blocked", detail: "resource repair intent was not durably persisted" };
  }
  let started: { status: "queued" | "blocked"; runId?: string };
  try {
    started = await input.start(input.prompt, { runId: resourceRepairRunId(record.id) });
  } catch {
    input.coordinator.releaseForRetry(record.id, input.now);
    return { status: "blocked", detail: "delegated repair threw and returned to retry" };
  }
  if (started.status === "blocked") {
    input.coordinator.releaseForRetry(record.id, input.now);
    return { status: "blocked", detail: "delegated repair was blocked and returned to retry" };
  }
  if (started.runId === undefined) {
    input.coordinator.releaseForRetry(record.id, input.now);
    return { status: "blocked", detail: "delegated repair returned no durable work order id" };
  }
  let attached: ReturnType<RepairCoordinator["attachWorkOrder"]>;
  try {
    attached = input.coordinator.attachWorkOrder(record.id, started.runId, input.now);
  } catch {
    input.coordinator.releaseForRetry(record.id, input.now);
    return {
      status: "blocked",
      detail: "repair work order attachment threw and returned to retry",
    };
  }
  if (attached === undefined) {
    input.coordinator.releaseForRetry(record.id, input.now);
    return { status: "blocked", detail: "repair work order could not be durably attached" };
  }
  return {
    status: "queued",
    detail: `resource repair queued on ${input.repairBranch}`,
    queueId: record.id,
    workOrderId: started.runId,
  };
}

export type ProductionResourceRepairDispatcherOptions = {
  coordinator?: RepairCoordinator;
  gitTopLevel?: (path: string) => Promise<string | null>;
  start?: typeof startActiveDelegatedTask;
  setSessionPath?: typeof setPathForSession;
};

/** Compose the existing globally durable repair queue with the active delegated-task surface. */
export function createProductionResourceRepairDispatcher(
  deps: HandlerDeps,
  options: ProductionResourceRepairDispatcherOptions = {},
): (
  incident: ResourceIncident,
  now: number,
  persistIntent?: (queueId: string) => Promise<void>,
) => Promise<ResourceGuardianRepairDispatch> {
  const coordinator = options.coordinator ?? new RepairCoordinator();
  const start = options.start ?? startActiveDelegatedTask;
  const setSessionPath = options.setSessionPath ?? setPathForSession;
  const gitTopLevel = options.gitTopLevel ?? defaultGitTopLevel;
  const repoPath = resolve(deps.config.runtimeGuardian.repoPath || process.cwd());
  return async (incident, now, persistIntent) => {
    if (!deps.config.loopEngineering.supervisor.enabled)
      return { status: "blocked", detail: "loop supervisor is disabled" };
    const session = sessionNameFromPath(repoPath, deps.config.projectSessionPrefix);
    return dispatchResourceGuardianRepair({
      now,
      repoPath,
      repairBranch: deps.config.runtimeGuardian.repairBranch,
      incident: {
        id: incident.id,
        fingerprint: incident.fingerprint,
        evidence: incident.actions.map((action) => action.reason).slice(-20),
      },
      coordinator,
      gitTopLevel,
      start: async (requirement, context) => {
        setSessionPath(session, repoPath);
        const result = await start(deps, {
          session,
          requirement,
          worktreeIsolation: deps.config.runtimeGuardian.worktreeIsolation,
          resourceTrigger: "resource-repair",
          trustedRunId: context.runId,
        });
        return result.status === "blocked"
          ? { status: "blocked" }
          : { status: "queued", runId: result.runId };
      },
      prompt: buildResourceGuardianRepairPrompt({
        repoPath,
        repairBranch: deps.config.runtimeGuardian.repairBranch,
        incident: {
          id: incident.id,
          fingerprint: incident.fingerprint,
          evidence: incident.actions.map((action) => action.reason).slice(-20),
        },
      }),
      ...(persistIntent === undefined ? {} : { persistIntent }),
    });
  };
}

function resourceRepairRunId(queueId: string): string {
  return `resource-repair-${queueId}`;
}

async function defaultGitTopLevel(repoPath: string): Promise<string | null> {
  return new Promise((resolveTopLevel) => {
    execFile(
      "git",
      ["-C", repoPath, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        timeout: 5_000,
        shell: false,
      },
      (error, stdout) => {
        const topLevel = typeof stdout === "string" ? stdout.trim() : "";
        resolveTopLevel(error === null && topLevel ? topLevel : null);
      },
    );
  });
}
