import { randomUUID } from "node:crypto";

import { appStateDir } from "../../shared/state-dir.js";
import type { AppConfig } from "../../shared/types.js";
import { createLogger, redactSecrets } from "../../shared/utils/logger.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import { readConfigEnvironment } from "../config/env-store.js";
import type { HandlerDeps } from "../deps.js";
import { notificationRequestForEvent } from "../notifications/events.js";
import type { NotificationRequest, NotificationResult } from "../notifications/gateway.js";
import { RepairCoordinator } from "../tasks/repair-coordinator.js";
import {
  createProductionResourceActionController,
  type ResourceActionController,
} from "./action-controller.js";
import { type ResourceActionPlan, sanitizeResourceActionReason } from "./actions.js";
import { recoverResourceGuardianOperatorUpdate } from "./operator-update.js";
import { advancePressureState, initialPressureMemory } from "./pressure-policy.js";
import {
  createProductionResourceRepairDispatcher,
  dispatchStableResourceRepair,
  type ResourceGuardianRepairDispatch,
  recordResourceRepairDispatchFailure,
} from "./repair.js";
import {
  createResourceSampler,
  defaultLightweightProbe,
  resourceSuspensionGapMs,
} from "./sampler.js";
import {
  createResourceGuardianStore,
  type ResourceGuardianCurrentRead,
  type ResourceGuardianCurrentState,
  type ResourceGuardianStore,
} from "./store.js";
import type {
  PressureMemory,
  PressureState,
  ResourceCircuitAdmission,
  ResourceGuardianMode,
  ResourceGuardianProfile,
  ResourceIncident,
  ResourceIncidentAction,
  ResourceSample,
  ResourceSamplingHealth,
  ResourceSamplingNotificationPhase,
} from "./types.js";

const log = createLogger("resource-guardian");
export const RESOURCE_GUARDIAN_STALE_HOLD_MS = 15 * 60_000;

type GuardianConfig = AppConfig["resourceGuardian"];
type ResourceSampleFn = (now: number, scheduledAt: number) => Promise<ResourceSample>;
type ResourceNotifyFn = (
  request: Omit<NotificationRequest, "channel">,
) => Promise<NotificationResult>;

export type ResourceGuardianTickRuntime = {
  initialized?: boolean;
  running?: boolean;
  memory?: PressureMemory;
  incident?: ResourceIncident | null;
  overlapSkippedCount?: number;
  lastEmergencyActionAt?: number;
};

export type ResourceGuardianTickResult =
  | {
      fired: false;
      reason: "disabled" | "in-progress" | "stopped" | "operator-update-failed";
      pressure?: undefined;
      circuit?: undefined;
      incidentId?: undefined;
    }
  | {
      fired: false;
      reason: "sample-failed" | "sample-stale";
      pressure: PressureState;
      circuit: ResourceCircuitAdmission;
      incidentId: string | null;
      detail: string;
    }
  | {
      fired: true;
      mode: ResourceGuardianMode;
      profile: ResourceGuardianProfile;
      pressure: PressureState;
      circuit: ResourceCircuitAdmission;
      incidentId: string | null;
      changed: boolean;
    };

export type ResourceGuardianCoordinatorOptions = {
  config: GuardianConfig;
  store: ResourceGuardianStore;
  sample: ResourceSampleFn;
  notify: ResourceNotifyFn;
  incidentId?: (capturedAt: number) => string;
  staleHoldMs?: number;
  runtime?: ResourceGuardianTickRuntime;
  isActive?: () => boolean;
  actionController?: ResourceActionController;
  repairDispatcher?: (
    incident: ResourceIncident,
    now: number,
    persistIntent?: (queueId: string) => Promise<void>,
  ) => Promise<ResourceGuardianRepairDispatch>;
  repairCoordinator?: RepairCoordinator;
  recoverOperatorUpdate?: () => void;
};

export type ResourceGuardianCoordinator = {
  readonly runtime: ResourceGuardianTickRuntime;
  run(
    now: number,
    scheduledAt?: number,
    isActive?: () => boolean,
  ): Promise<ResourceGuardianTickResult>;
};

export function createResourceGuardianCoordinator(
  options: ResourceGuardianCoordinatorOptions,
): ResourceGuardianCoordinator {
  const runtime = options.runtime ?? {};
  return {
    runtime,
    run: (now, scheduledAt = now, isActive = options.isActive) =>
      runResourceGuardianTick({
        ...options,
        runtime,
        now,
        scheduledAt,
        ...(isActive ? { isActive } : {}),
      }),
  };
}

export async function runResourceGuardianTick(
  input: ResourceGuardianCoordinatorOptions & {
    now: number;
    scheduledAt?: number;
  },
): Promise<ResourceGuardianTickResult> {
  if (!input.config.enabled || input.config.tickMs === 0) {
    return { fired: false, reason: "disabled" };
  }
  const runtime = input.runtime ?? {};
  if (runtime.running) {
    runtime.overlapSkippedCount = (runtime.overlapSkippedCount ?? 0) + 1;
    return { fired: false, reason: "in-progress" };
  }

  runtime.running = true;
  try {
    const current = input.store.readCurrent();
    const staleHoldMs = input.staleHoldMs ?? RESOURCE_GUARDIAN_STALE_HOLD_MS;
    initializeRuntime(runtime, current, input.store, input.now);
    if (runtime.incident === null && current.circuit.incidentId) {
      runtime.incident = restoreIncident(current, input.store);
    }
    try {
      input.recoverOperatorUpdate?.();
    } catch (error) {
      log.warn("resource guardian operator update recovery failed", {
        err: safeErrorMessage(error),
      });
      return { fired: false, reason: "operator-update-failed" };
    }
    const operator = input.store.readOperator();
    const mode = operator?.mode ?? input.config.mode;
    const profile = operator?.profile ?? input.config.profile;

    let freshSample: ResourceSample;
    try {
      freshSample = await input.sample(input.now, input.scheduledAt ?? input.now);
    } catch (error) {
      if (!isActive(input)) return { fired: false, reason: "stopped" };
      return handleSampleFailure({
        now: input.now,
        current,
        runtime,
        store: input.store,
        notify: input.notify,
        staleHoldMs,
        error,
        requestedMode: mode,
        profile,
        incidentId: input.incidentId ?? defaultIncidentId,
      });
    }
    if (!isActive(input)) return { fired: false, reason: "stopped" };

    const previousPressure = current.circuit.pressure;
    const nextMemory = advancePressureState(
      runtime.memory ?? initialPressureMemory(freshSample.capturedAt),
      freshSample,
      profile,
    );
    const pressure = nextMemory.pressure;
    const circuit = admissionFor(mode, pressure);
    const actionSummary = actionSummaryFor(mode, pressure);
    const reason = reasonFor(mode, pressure, circuit);
    const pressureChanged = previousPressure !== pressure;
    const stateChanged =
      current.degraded || pressureChanged || current.circuit.admission !== circuit;
    let nextIncident = runtime.incident ? structuredClone(runtime.incident) : null;

    if (pressure !== "healthy" && nextIncident === null) {
      const id = (input.incidentId ?? defaultIncidentId)(freshSample.capturedAt);
      nextIncident = {
        schemaVersion: 1,
        id,
        fingerprint: `resource-pressure:${id}`,
        attribution: "unknown",
        startedAt: freshSample.capturedAt,
        pressure,
        samples: [],
        transitions: [],
        actions: [],
      };
    }

    const overlapSkippedCount = runtime.overlapSkippedCount ?? 0;
    if (nextIncident !== null) {
      nextIncident.samples.push(freshSample);
      nextIncident.pressure = pressure;
      if (pressureChanged) {
        nextIncident.transitions.push({
          at: freshSample.capturedAt,
          from: previousPressure,
          to: pressure,
          hostCpuPct: freshSample.hostCpuPct,
          circuit,
          reason: actionSummary,
        });
        nextIncident.actions.push({
          at: freshSample.capturedAt,
          kind: "transition",
          outcome: "recorded",
          reason: `${previousPressure} -> ${pressure}; ${actionSummary}`,
        });
      }
      if (overlapSkippedCount > 0) {
        nextIncident.actions.push({
          at: freshSample.capturedAt,
          kind: "overlap-skipped",
          outcome: "skipped",
          reason: "resource guardian skipped overlapping timer ticks",
          count: overlapSkippedCount,
        });
      }
      if (pressure === "healthy") nextIncident.endedAt = freshSample.capturedAt;
    }

    const incidentId = pressure === "healthy" ? null : (nextIncident?.id ?? null);
    const sampling = healthySampling(
      current.view.sampling.overlapSkippedTicks + overlapSkippedCount,
    );
    const stableSince = stableSinceFor({
      pressure,
      previous: current.view.stableSince ?? null,
      now: freshSample.capturedAt,
    });
    const nextCurrent: ResourceGuardianCurrentState = {
      circuit: {
        schemaVersion: 1,
        pressure,
        incidentId,
        admission: circuit,
        reason,
        changedAt: stateChanged ? freshSample.capturedAt : current.circuit.changedAt,
        lastSampleAt: freshSample.capturedAt,
        owner: "resource-guardian",
      },
      view: {
        enabled: input.config.enabled,
        mode,
        profile,
        pressure,
        circuit,
        incidentId,
        reason,
        attribution: "unknown",
        latestSample: freshSample,
        stableSince,
        sampling,
      },
    };
    const opening = safetyRank(circuit) < safetyRank(current.circuit.admission);
    let incidentPersisted = false;
    if (opening && nextIncident) {
      input.store.writeIncident(nextIncident);
      incidentPersisted = true;
    }
    input.store.writeCurrent(nextCurrent);
    if (!opening && nextIncident) {
      incidentPersisted = writeIncidentBestEffort(input.store, nextIncident);
    }

    if (
      input.actionController !== undefined &&
      pressure === "emergency" &&
      (mode === "observe" || circuit === "background-closed") &&
      (mode === "observe"
        ? pressureChanged
        : pressureChanged ||
          runtime.lastEmergencyActionAt === undefined ||
          freshSample.capturedAt - runtime.lastEmergencyActionAt >= 30_000)
    ) {
      if (mode === "protect") runtime.lastEmergencyActionAt = freshSample.capturedAt;
      let prepared: ResourceActionPlan = { kind: "none" };
      let preparationFailure: string | undefined;
      try {
        prepared = await input.actionController.prepare({
          now: freshSample.capturedAt,
          pressure,
          circuit,
          incidentId,
        });
      } catch (error) {
        preparationFailure = sanitizeResourceActionReason(
          `action preparation failed: ${String(error)}`,
        );
        if (nextIncident) {
          nextIncident.actions.push({
            kind: "resource-action",
            at: freshSample.capturedAt,
            outcome: "failed",
            reason: preparationFailure,
          });
          if (writeIncidentBestEffort(input.store, nextIncident)) runtime.incident = nextIncident;
        }
      }
      const planReason = prepared.kind === "reduce-load" ? "reduce-load" : "no safe candidate";
      if (preparationFailure !== undefined) {
        const notifiedIncident = await notifyResourceActionFailed({
          notify: input.notify,
          store: input.store,
          incident: nextIncident,
          at: freshSample.capturedAt,
          incidentId,
          circuit,
          reason: preparationFailure,
        });
        if (notifiedIncident) {
          nextIncident = notifiedIncident;
          runtime.incident = notifiedIncident;
        }
      } else if (mode === "observe") {
        const action = { outcome: "skipped" as const, reason: `proposed: ${planReason}` };
        if (nextIncident) {
          nextIncident.actions.push({
            kind: "resource-action",
            at: freshSample.capturedAt,
            outcome: "skipped",
            reason: action.reason,
          });
          if (writeIncidentBestEffort(input.store, nextIncident)) runtime.incident = nextIncident;
        }
      } else {
        let intentPersisted = false;
        if (nextIncident) {
          const target = actionTarget(prepared);
          if (target !== undefined) nextIncident.attribution = "bot-owned";
          nextIncident.actions.push({
            kind: "resource-action",
            at: freshSample.capturedAt,
            outcome: "recorded",
            reason: `intent: ${planReason}`,
            ...(target === undefined ? {} : { target }),
          });
          intentPersisted = writeIncidentBestEffort(input.store, nextIncident);
        }
        if (intentPersisted) runtime.incident = nextIncident;
        if (!intentPersisted) {
          const failureReason =
            "resource action intent was not durably persisted; refusing effects";
          const notifiedIncident = await notifyResourceActionFailed({
            notify: input.notify,
            store: input.store,
            incident: nextIncident,
            at: freshSample.capturedAt,
            incidentId,
            circuit,
            reason: failureReason,
          });
          if (notifiedIncident) {
            nextIncident = notifiedIncident;
            runtime.incident = notifiedIncident;
          }
        } else {
          let action: { outcome: "skipped" | "completed" | "failed"; reason: string } = {
            outcome: "failed",
            reason: "resource action execution failed",
          };
          try {
            action = await input.actionController.execute(prepared);
          } catch (error) {
            action = {
              outcome: "failed",
              reason: sanitizeResourceActionReason(`action execution failed: ${String(error)}`),
            };
          }
          const actionReason = sanitizeResourceActionReason(action.reason);
          if (nextIncident) {
            nextIncident.actions.push({
              kind: "resource-action",
              at: freshSample.capturedAt,
              phase: "deterministic-cleanup",
              outcome:
                action.outcome === "completed"
                  ? "recorded"
                  : action.outcome === "skipped"
                    ? "skipped"
                    : "failed",
              reason: actionReason,
            });
            if (writeIncidentBestEffort(input.store, nextIncident)) runtime.incident = nextIncident;
          }
          if (action.outcome === "failed") {
            const notifiedIncident = await notifyResourceActionFailed({
              notify: input.notify,
              store: input.store,
              incident: nextIncident,
              at: freshSample.capturedAt,
              incidentId,
              circuit,
              reason: actionReason,
            });
            if (notifiedIncident) {
              nextIncident = notifiedIncident;
              runtime.incident = notifiedIncident;
            }
          }
        }
      }
    }

    if (input.repairDispatcher !== undefined) {
      try {
        await dispatchStableResourceRepair({
          now: freshSample.capturedAt,
          pressure,
          circuit,
          stableSince,
          store: input.store,
          dispatch: input.repairDispatcher,
          ...(input.repairCoordinator === undefined
            ? {}
            : { coordinator: input.repairCoordinator }),
        });
      } catch (error) {
        const reason = `repair dispatch failed: ${safeErrorMessage(error)}`;
        log.warn("resource guardian repair dispatch failed", { data: { reason } });
        recordResourceRepairDispatchFailure({
          now: freshSample.capturedAt,
          reason,
          store: input.store,
        });
      }
    }

    runtime.memory = nextMemory;
    runtime.overlapSkippedCount = 0;
    if (pressure === "healthy") runtime.incident = null;
    else if (incidentPersisted) runtime.incident = nextIncident;

    if (pressureChanged) {
      const notifiedIncident = await notifyTransition({
        notify: input.notify,
        store: input.store,
        incident: nextIncident,
        at: freshSample.capturedAt,
        oldState: previousPressure,
        newState: pressure,
        hostCpuPct: freshSample.hostCpuPct,
        loadPct: freshSample.loadPct,
        eventLoopLagMs: freshSample.eventLoopLagMs,
        circuit,
        actionSummary,
      });
      if (pressure !== "healthy" && notifiedIncident) runtime.incident = notifiedIncident;
    }

    return { fired: true, mode, profile, pressure, circuit, incidentId, changed: stateChanged };
  } finally {
    runtime.running = false;
  }
}

function initializeRuntime(
  runtime: ResourceGuardianTickRuntime,
  current: ResourceGuardianCurrentRead,
  store: ResourceGuardianStore,
  now: number,
): void {
  if (runtime.initialized) return;
  const restorePressure =
    current.circuit.pressure !== "healthy" || current.circuit.admission !== "open";
  const guardedPressure =
    current.circuit.pressure === "healthy" ? "critical" : current.circuit.pressure;
  const memory = initialPressureMemory(now);
  runtime.memory = restorePressure
    ? {
        ...memory,
        pressure: guardedPressure,
        stateSince: current.circuit.changedAt,
        recoverySince: null,
      }
    : memory;
  runtime.incident = restoreIncident(current, store);
  const lastEmergencyActionAt = runtime.incident?.actions
    .filter(
      (action) =>
        action.kind === "resource-action" &&
        action.outcome === "recorded" &&
        action.reason.startsWith("intent:"),
    )
    .reduce<number | undefined>(
      (latest, action) => Math.max(latest ?? action.at, action.at),
      undefined,
    );
  if (lastEmergencyActionAt !== undefined) runtime.lastEmergencyActionAt = lastEmergencyActionAt;
  runtime.overlapSkippedCount = 0;
  runtime.initialized = true;
}

function restoreIncident(
  current: ResourceGuardianCurrentRead,
  store: ResourceGuardianStore,
): ResourceIncident | null {
  const id = current.circuit.incidentId;
  if (!id) return null;
  const stored = store
    .listIncidents()
    .find((candidate) => candidate.id === id && candidate.endedAt === undefined);
  if (stored) return stored;
  return {
    schemaVersion: 1,
    id,
    fingerprint: `resource-pressure:${id}`,
    attribution: "unknown",
    startedAt: current.circuit.changedAt,
    pressure: current.circuit.pressure,
    samples: current.view.latestSample ? [current.view.latestSample] : [],
    transitions: [],
    actions: [],
  };
}

async function handleSampleFailure(input: {
  now: number;
  current: ResourceGuardianCurrentRead;
  runtime: ResourceGuardianTickRuntime;
  store: ResourceGuardianStore;
  notify: ResourceNotifyFn;
  staleHoldMs: number;
  error: unknown;
  requestedMode: ResourceGuardianMode;
  profile: ResourceGuardianProfile;
  incidentId: (capturedAt: number) => string;
}): Promise<ResourceGuardianTickResult> {
  const detail = safeErrorMessage(input.error);
  const age = Math.max(0, input.now - input.current.circuit.lastSampleAt);
  const isClosed = input.current.circuit.admission !== "open";
  const explicitObserve = input.requestedMode === "observe";
  const staleObserveLatched = input.current.view.sampling.notifiedPhase === "stale-hold-expired";
  const staleExpired = !explicitObserve && isClosed && age > input.staleHoldMs;
  const effectiveObserve = explicitObserve || staleExpired || staleObserveLatched;
  const circuit = effectiveObserve ? "open" : input.current.circuit.admission;
  const effectiveMode: ResourceGuardianMode = effectiveObserve ? "observe" : "protect";
  const reason = staleExpired
    ? "resource sample is stale beyond the safety hold; degraded to observe-only with circuit open"
    : staleObserveLatched
      ? input.current.circuit.reason
      : explicitObserve
        ? "observe mode is authoritative; sampling is degraded and admission remains open"
        : input.current.circuit.reason;
  const consecutiveFailures = input.current.view.sampling.consecutiveFailures + 1;
  const notificationPhases: ResourceSamplingNotificationPhase[] = [];
  if (consecutiveFailures >= 2 && input.current.view.sampling.notifiedPhase === null) {
    notificationPhases.push("sampling-failed");
  }
  if (staleExpired && input.current.view.sampling.notifiedPhase !== "stale-hold-expired") {
    notificationPhases.push("stale-hold-expired");
  }
  const notifiedPhase = notificationPhases.at(-1) ?? input.current.view.sampling.notifiedPhase;
  const sampling: ResourceSamplingHealth = {
    degraded: true,
    consecutiveFailures,
    lastFailureAt: input.now,
    lastError: detail,
    notifiedPhase,
    overlapSkippedTicks:
      input.current.view.sampling.overlapSkippedTicks + (input.runtime.overlapSkippedCount ?? 0),
  };
  let nextIncident = input.runtime.incident
    ? structuredClone(input.runtime.incident)
    : restoreIncident(input.current, input.store);
  if (nextIncident === null && input.current.circuit.pressure !== "healthy") {
    const id = input.current.circuit.incidentId ?? input.incidentId(input.now);
    nextIncident = {
      schemaVersion: 1,
      id,
      fingerprint: `resource-pressure:${id}`,
      attribution: "unknown",
      startedAt: input.current.circuit.changedAt,
      pressure: input.current.circuit.pressure,
      samples: input.current.view.latestSample ? [input.current.view.latestSample] : [],
      transitions: [],
      actions: [],
    };
  }
  if (nextIncident) {
    for (const phase of notificationPhases) {
      nextIncident.actions.push({
        kind: "sampling-degraded",
        at: input.now,
        outcome: "recorded",
        reason: `${phase}: ${detail}`,
      });
    }
  }
  const nextCurrent: ResourceGuardianCurrentState = {
    circuit: {
      ...input.current.circuit,
      incidentId: nextIncident?.id ?? input.current.circuit.incidentId,
      admission: circuit,
      reason,
      changedAt: staleExpired ? input.now : input.current.circuit.changedAt,
    },
    view: {
      ...input.current.view,
      enabled: true,
      mode: effectiveMode,
      profile: input.profile,
      circuit,
      incidentId: nextIncident?.id ?? input.current.view.incidentId,
      reason,
      stableSince: null,
      sampling,
    },
  };
  const opening = safetyRank(circuit) < safetyRank(input.current.circuit.admission);
  let incidentPersisted = false;
  if (opening && nextIncident) {
    input.store.writeIncident(nextIncident);
    incidentPersisted = true;
  }
  input.store.writeCurrent(nextCurrent);
  if (!opening && nextIncident) {
    incidentPersisted = writeIncidentBestEffort(input.store, nextIncident);
  }
  input.runtime.overlapSkippedCount = 0;
  if (incidentPersisted) input.runtime.incident = nextIncident;

  for (const phase of notificationPhases) {
    const notifiedIncident = await notifySamplingDegraded({
      notify: input.notify,
      store: input.store,
      incident: nextIncident,
      at: input.now,
      phase,
      incidentId: nextIncident?.id ?? input.current.circuit.incidentId,
      error: detail,
      consecutiveFailures: sampling.consecutiveFailures,
      circuit,
    });
    if (notifiedIncident) {
      nextIncident = notifiedIncident;
      input.runtime.incident = notifiedIncident;
    }
  }

  return {
    fired: false,
    reason: staleExpired ? "sample-stale" : "sample-failed",
    pressure: input.current.circuit.pressure,
    circuit,
    incidentId: nextIncident?.id ?? input.current.circuit.incidentId,
    detail,
  };
}

async function notifyTransition(input: {
  notify: ResourceNotifyFn;
  store: ResourceGuardianStore;
  incident: ResourceIncident | null;
  at: number;
  oldState: PressureState;
  newState: PressureState;
  hostCpuPct: number;
  loadPct: number;
  eventLoopLagMs: number;
  circuit: ResourceCircuitAdmission;
  actionSummary: string;
}): Promise<ResourceIncident | null> {
  let outcome: ResourceIncidentAction["outcome"] = "failed";
  let reason = input.actionSummary;
  try {
    const request = notificationRequestForEvent({
      kind: "resource.pressure-transition",
      oldState: input.oldState,
      newState: input.newState,
      incidentId: input.incident?.id ?? null,
      hostCpuPct: input.hostCpuPct,
      loadPct: input.loadPct,
      eventLoopLagMs: input.eventLoopLagMs,
      circuit: input.circuit,
      actionSummary: input.actionSummary,
    });
    if (request === null) {
      outcome = "skipped";
      reason = `${input.actionSummary}; notification not actionable`;
    } else {
      const result = await input.notify(request);
      outcome = notificationOutcome(result.status);
      reason = `${input.actionSummary}; notification ${result.status}`;
    }
  } catch (error) {
    reason = `${input.actionSummary}; notification failed: ${safeErrorMessage(error)}`;
  }
  if (input.incident) {
    const nextIncident = structuredClone(input.incident);
    nextIncident.actions.push({
      at: input.at,
      kind: "notification",
      outcome,
      reason,
    });
    return writeIncidentBestEffort(input.store, nextIncident) ? nextIncident : null;
  }
  return null;
}

async function notifySamplingDegraded(input: {
  notify: ResourceNotifyFn;
  store: ResourceGuardianStore;
  incident: ResourceIncident | null;
  at: number;
  phase: ResourceSamplingNotificationPhase;
  incidentId: string | null;
  error: string;
  consecutiveFailures: number;
  circuit: ResourceCircuitAdmission;
}): Promise<ResourceIncident | null> {
  let outcome: ResourceIncidentAction["outcome"] = "failed";
  let reason = `${input.phase} notification failed`;
  try {
    const request = notificationRequestForEvent({
      kind: "resource.sampling-degraded",
      phase: input.phase,
      incidentId: input.incidentId,
      error: input.error,
      consecutiveFailures: input.consecutiveFailures,
      circuit: input.circuit,
    });
    if (request === null) {
      outcome = "skipped";
      reason = `${input.phase} notification not actionable`;
    } else {
      const result = await input.notify(request);
      outcome = notificationOutcome(result.status);
      reason = `${input.phase} notification ${result.status}`;
    }
  } catch (error) {
    reason = `${input.phase} notification failed: ${safeErrorMessage(error)}`;
  }
  if (!input.incident) return null;
  const nextIncident = structuredClone(input.incident);
  nextIncident.actions.push({ kind: "notification", at: input.at, outcome, reason });
  return writeIncidentBestEffort(input.store, nextIncident) ? nextIncident : null;
}

async function notifyResourceActionFailed(input: {
  notify: ResourceNotifyFn;
  store: ResourceGuardianStore;
  incident: ResourceIncident | null;
  at: number;
  incidentId: string | null;
  circuit: ResourceCircuitAdmission;
  reason: string;
}): Promise<ResourceIncident | null> {
  let outcome: ResourceIncidentAction["outcome"] = "failed";
  const safeReason = sanitizeResourceActionReason(input.reason);
  let reason = safeReason;
  try {
    const request = notificationRequestForEvent({
      kind: "resource.action-failed",
      incidentId: input.incidentId,
      circuit: input.circuit,
      reason: safeReason,
    });
    if (request === null) {
      outcome = "skipped";
      reason = `${safeReason}; notification not actionable`;
    } else {
      const result = await input.notify(request);
      outcome = notificationOutcome(result.status);
      reason = `${safeReason}; notification ${result.status}`;
    }
  } catch (error) {
    reason = `${safeReason}; notification failed: ${sanitizeResourceActionReason(error)}`;
  }
  if (!input.incident) return null;
  const nextIncident = structuredClone(input.incident);
  nextIncident.actions.push({ kind: "notification", at: input.at, outcome, reason });
  return writeIncidentBestEffort(input.store, nextIncident) ? nextIncident : null;
}

function notificationOutcome(
  status: NotificationResult["status"],
): ResourceIncidentAction["outcome"] {
  return status === "suppressed" ? "skipped" : status;
}

function isActive(input: { isActive?: () => boolean }): boolean {
  return input.isActive?.() ?? true;
}

function safetyRank(admission: ResourceCircuitAdmission): number {
  if (admission === "open") return 0;
  if (admission === "heavy-closed") return 1;
  return 2;
}

function healthySampling(overlapSkippedTicks: number): ResourceSamplingHealth {
  return {
    degraded: false,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastError: null,
    notifiedPhase: null,
    overlapSkippedTicks,
  };
}

function stableSinceFor(input: {
  pressure: PressureState;
  previous: number | null;
  now: number;
}): number | null {
  if (input.pressure !== "healthy") return null;
  if (input.previous !== null && input.previous > input.now) return null;
  return input.previous ?? input.now;
}

function writeIncidentBestEffort(
  store: ResourceGuardianStore,
  incident: ResourceIncident,
): boolean {
  try {
    store.writeIncident(incident);
    return true;
  } catch (error) {
    log.warn("resource guardian incident evidence write failed", {
      err: safeErrorMessage(error),
    });
    return false;
  }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const genericRedacted = raw.replace(
    /\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
    "$1=<redacted>",
  );
  return tildeifyHome(redactSecrets(genericRedacted)).slice(0, 500);
}

function actionTarget(plan: ResourceActionPlan): ResourceIncidentAction["target"] | undefined {
  if (plan.kind === "none" || plan.candidate.workOrderId === undefined) return undefined;
  const { process, workOrderId, session, leaseId } = plan.candidate;
  return {
    pid: process.pid,
    startedAt: process.startedAt,
    workOrderId,
    ...(session === undefined ? {} : { session }),
    ...(leaseId === undefined ? {} : { leaseId }),
  };
}

function admissionFor(
  mode: ResourceGuardianMode,
  pressure: PressureState,
): ResourceCircuitAdmission {
  if (mode === "observe" || pressure === "healthy") return "open";
  if (pressure === "elevated" || pressure === "recovering") return "heavy-closed";
  return "background-closed";
}

function actionSummaryFor(mode: ResourceGuardianMode, pressure: PressureState): string {
  if (mode === "observe") return "observe mode kept resource admission open";
  if (pressure === "healthy") return "protect mode reopened resource admission";
  if (pressure === "elevated") return "protect mode closed heavy background admission";
  if (pressure === "recovering") return "protect mode reopened light background admission";
  return "protect mode closed background admission";
}

function reasonFor(
  mode: ResourceGuardianMode,
  pressure: PressureState,
  circuit: ResourceCircuitAdmission,
): string {
  if (mode === "observe")
    return `observe mode recorded ${pressure} pressure; admission remains open`;
  if (circuit === "open") return "resource pressure is healthy; admission is open";
  return `${pressure} resource pressure; ${circuit} admission protection is active`;
}

function defaultIncidentId(capturedAt: number): string {
  return `${capturedAt}-${randomUUID()}`;
}

type TimerHandle = ReturnType<typeof setInterval>;

export type StartResourceGuardianOptions = {
  store?: ResourceGuardianStore;
  sample?: ResourceSampleFn;
  now?: () => number;
  incidentId?: (capturedAt: number) => string;
  staleHoldMs?: number;
  setInterval?: (tick: () => void, delayMs: number) => TimerHandle;
  clearInterval?: (timer: TimerHandle) => void;
  actionController?: ResourceGuardianCoordinatorOptions["actionController"];
  repairDispatcher?: ResourceGuardianCoordinatorOptions["repairDispatcher"];
  repairCoordinator?: RepairCoordinator;
  recoverOperatorUpdate?: () => void;
};

export function startResourceGuardian(
  deps: HandlerDeps,
  options: StartResourceGuardianOptions = {},
): () => void {
  const config = deps.config.resourceGuardian;
  if (!config.enabled || config.tickMs === 0) {
    log.info("resource guardian disabled");
    return () => {};
  }

  const now = options.now ?? Date.now;
  const actionController =
    options.actionController ?? createProductionResourceActionController(deps);
  const repairCoordinator = options.repairCoordinator ?? new RepairCoordinator();
  const repairDispatcher =
    options.repairDispatcher ??
    createProductionResourceRepairDispatcher(deps, { coordinator: repairCoordinator });
  const store = options.store ?? createResourceGuardianStore({ stateDir: appStateDir(), now });
  const suspensionGapMs = resourceSuspensionGapMs(config.tickMs);
  const sampler = createResourceSampler(
    defaultLightweightProbe(),
    async () => ({
      capturedAt: now(),
      thermal: "unknown",
      processes: [],
    }),
    { suspensionGapMs },
  );
  const coordinator = createResourceGuardianCoordinator({
    config,
    store,
    sample:
      options.sample ??
      ((sampleAt, scheduledAt) => sampler.sample({ now: sampleAt, scheduledAt, deep: false })),
    notify: (request) => deps.notifications.notify(request),
    ...(options.incidentId ? { incidentId: options.incidentId } : {}),
    ...(options.staleHoldMs === undefined ? {} : { staleHoldMs: options.staleHoldMs }),
    actionController,
    repairDispatcher,
    repairCoordinator,
    recoverOperatorUpdate:
      options.recoverOperatorUpdate ??
      (() => {
        const outcome = recoverResourceGuardianOperatorUpdate({
          store,
          readEnvironment: readConfigEnvironment,
        });
        if (outcome === "busy") throw new Error("Resource Guardian operator update is in progress");
      }),
  });
  let stopped = false;
  let generation = 0;
  const runScheduledTick = (scheduledAt: number, actualNow?: number): void => {
    if (stopped) return;
    const tickGeneration = generation;
    void coordinator
      .run(actualNow ?? now(), scheduledAt, () => !stopped && generation === tickGeneration)
      .catch((error) => {
        log.warn("resource guardian tick failed", { err: safeErrorMessage(error) });
      });
  };
  const setIntervalFn: (tick: () => void, delayMs: number) => TimerHandle =
    options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const clearIntervalFn: (timer: TimerHandle) => void =
    options.clearInterval ?? ((handle) => clearInterval(handle));
  const initialScheduledAt = now();
  let nextScheduledAt = initialScheduledAt + config.tickMs;
  const timer = setIntervalFn(() => {
    const scheduledAt = nextScheduledAt;
    const actualNow = now();
    nextScheduledAt =
      actualNow - scheduledAt > suspensionGapMs
        ? actualNow + config.tickMs
        : nextScheduledAt + config.tickMs;
    runScheduledTick(scheduledAt, actualNow);
  }, config.tickMs);
  (timer as { unref?: () => void }).unref?.();
  runScheduledTick(initialScheduledAt);
  log.info("resource guardian started", {
    data: { mode: config.mode, profile: config.profile, tickMs: config.tickMs },
  });

  return () => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearIntervalFn(timer);
  };
}
