import { randomUUID } from "node:crypto";

import { appStateDir } from "../../shared/state-dir.js";
import type { AppConfig } from "../../shared/types.js";
import { createLogger, redactSecrets } from "../../shared/utils/logger.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import type { HandlerDeps } from "../deps.js";
import { notificationRequestForEvent } from "../notifications/events.js";
import type { NotificationRequest, NotificationResult } from "../notifications/gateway.js";
import { advancePressureState, initialPressureMemory } from "./pressure-policy.js";
import { createResourceSampler, defaultLightweightProbe } from "./sampler.js";
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
};

export type ResourceGuardianTickResult =
  | {
      fired: false;
      reason: "disabled" | "in-progress" | "stopped";
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
  circuit: ResourceCircuitAdmission;
  actionSummary: string;
}): Promise<ResourceIncident | null> {
  let outcome: ResourceIncidentAction["outcome"] = "failed";
  let reason = input.actionSummary;
  try {
    const result = await input.notify(
      notificationRequestForEvent({
        kind: "resource.pressure-transition",
        oldState: input.oldState,
        newState: input.newState,
        incidentId: input.incident?.id ?? null,
        hostCpuPct: input.hostCpuPct,
        circuit: input.circuit,
        actionSummary: input.actionSummary,
      }),
    );
    outcome = result.status;
    reason = `${input.actionSummary}; notification ${result.status}`;
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
    const result = await input.notify(
      notificationRequestForEvent({
        kind: "resource.sampling-degraded",
        phase: input.phase,
        incidentId: input.incidentId,
        error: input.error,
        consecutiveFailures: input.consecutiveFailures,
        circuit: input.circuit,
      }),
    );
    outcome = result.status;
    reason = `${input.phase} notification ${result.status}`;
  } catch (error) {
    reason = `${input.phase} notification failed: ${safeErrorMessage(error)}`;
  }
  if (!input.incident) return null;
  const nextIncident = structuredClone(input.incident);
  nextIncident.actions.push({ kind: "notification", at: input.at, outcome, reason });
  return writeIncidentBestEffort(input.store, nextIncident) ? nextIncident : null;
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

function admissionFor(
  mode: ResourceGuardianMode,
  pressure: PressureState,
): ResourceCircuitAdmission {
  if (mode === "observe" || pressure === "healthy") return "open";
  if (pressure === "elevated") return "heavy-closed";
  return "background-closed";
}

function actionSummaryFor(mode: ResourceGuardianMode, pressure: PressureState): string {
  if (mode === "observe") return "observe mode kept resource admission open";
  if (pressure === "healthy") return "protect mode reopened resource admission";
  if (pressure === "elevated") return "protect mode closed heavy background admission";
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
};

export function startResourceGuardian(
  deps: Pick<HandlerDeps, "config" | "notifications">,
  options: StartResourceGuardianOptions = {},
): () => void {
  const config = deps.config.resourceGuardian;
  if (!config.enabled || config.tickMs === 0) {
    log.info("resource guardian disabled");
    return () => {};
  }

  const now = options.now ?? Date.now;
  const store = options.store ?? createResourceGuardianStore({ stateDir: appStateDir(), now });
  const sampler = createResourceSampler(defaultLightweightProbe(), async () => ({
    capturedAt: now(),
    thermal: "unknown",
    processes: [],
  }));
  const coordinator = createResourceGuardianCoordinator({
    config,
    store,
    sample:
      options.sample ??
      ((sampleAt, scheduledAt) => sampler.sample({ now: sampleAt, scheduledAt, deep: false })),
    notify: (request) => deps.notifications.notify(request),
    ...(options.incidentId ? { incidentId: options.incidentId } : {}),
    ...(options.staleHoldMs === undefined ? {} : { staleHoldMs: options.staleHoldMs }),
  });
  let stopped = false;
  let generation = 0;
  const runScheduledTick = (scheduledAt: number): void => {
    if (stopped) return;
    const tickGeneration = generation;
    void coordinator
      .run(now(), scheduledAt, () => !stopped && generation === tickGeneration)
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
    nextScheduledAt += config.tickMs;
    runScheduledTick(scheduledAt);
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
