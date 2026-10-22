import type { HostPowerConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { HandlerDeps } from "../deps.js";
import { createKeepAwakeController, type KeepAwakeController } from "../platform/keep-awake.js";
import { resolveHostPowerPhase } from "../platform/power-policy.js";
import { inspectPowerSchedule, type PowerScheduleInspection } from "../platform/power-schedule.js";
import { type MacPowerSource, readMacPowerSource } from "../platform/power-source.js";
import { createPowerEventRecorder, type PowerEvent } from "./power-event-journal.js";
import { createProtectedWorkProbe, type ProtectedWorkSnapshot } from "./protected-work.js";

const log = createLogger("power.manager");
const POWER_RECONCILE_MS = 30_000;
type TimerHandle = { unref?(): void };

export type HostPowerManagerOptions = {
  now(): number;
  keepAwake: KeepAwakeController;
  hasProtectedWork(): Promise<ProtectedWorkSnapshot>;
  inspectSchedule(): PowerScheduleInspection;
  readPowerSource(): MacPowerSource;
  notifyDegraded(
    reason: string,
    delivery: { topic: string; state: string; window?: string },
  ): Promise<void>;
  recordEvent(event: PowerEvent): void;
  setInterval(tick: () => void, delayMs: number): TimerHandle;
  clearInterval(timer: TimerHandle): void;
};

export type HostPowerManager = {
  reconcile(): Promise<void>;
  start(): void;
  stop(): void;
};

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function createHostPowerManager(
  config: HostPowerConfig,
  options: HostPowerManagerOptions,
): HostPowerManager {
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let lastDegradedKey: string | undefined;
  let lastPhase: ReturnType<typeof resolveHostPowerPhase> | null = null;
  let assertionHeld = options.keepAwake.active();
  let lastDelayKey: string | undefined;
  const isStopped = (): boolean => stopped;
  const recordEvent = (event: PowerEvent): void => {
    try {
      options.recordEvent(event);
    } catch (error) {
      log.warn("power event recorder failed", { err: safeError(error) });
    }
  };

  const recordPhase = (phase: ReturnType<typeof resolveHostPowerPhase>, at: number): void => {
    if (lastPhase === phase) return;
    recordEvent({ at, kind: "phase-transition", from: lastPhase, to: phase });
    lastPhase = phase;
    lastDelayKey = undefined;
  };

  const notifyDegradation = async (
    reason: string,
    delivery: { topic: string; state: string; window?: string },
  ): Promise<void> => {
    const key = `${delivery.topic}\0${delivery.state}\0${delivery.window ?? "state"}`;
    if (key !== lastDegradedKey) {
      lastDegradedKey = key;
      recordEvent({ at: options.now(), kind: "degraded", reason });
      log.warn("scheduled natural sleep is degraded; failing awake", { data: { reason } });
    }
    // Retry the delivery boundary on every reconciliation. The gateway suppresses
    // channels that already succeeded, while a failed channel remains retryable.
    await options.notifyDegraded(reason, delivery).catch((error) => {
      log.warn("power degradation notification failed", { err: safeError(error) });
    });
  };

  const acquireOrNotify = async (at: number): Promise<void> => {
    if (!options.keepAwake.acquire()) {
      await notifyDegradation("caffeinate assertion could not be acquired", {
        topic: "power:keep-awake",
        state: "acquire-failed",
      });
      return;
    }
    if (assertionHeld !== true) {
      assertionHeld = true;
      recordEvent({ at, kind: "keep-awake-acquired" });
    }
    let source: MacPowerSource = "unknown";
    try {
      source = options.readPowerSource();
    } catch (error) {
      await notifyDegradation(`power-source probe failed: ${safeError(error)}`, {
        topic: "power:power-source-probe",
        state: "failed",
      });
      return;
    }
    if (source === "battery") return;
    lastDegradedKey = undefined;
  };

  const failAwake = async (reason: string, at: number): Promise<void> => {
    const acquired = options.keepAwake.acquire();
    if (acquired && assertionHeld !== true) {
      assertionHeld = true;
      recordEvent({ at, kind: "keep-awake-acquired" });
    }
    const fullReason = acquired ? reason : `${reason}; caffeinate assertion could not be acquired`;
    await notifyDegradation(fullReason, {
      topic: reason.startsWith("protected-work probe failed")
        ? "power:protected-work-probe"
        : "power:wake-schedule",
      state: reason.split(":", 1)[0] ?? reason,
      window: quietCycleKey(config, at),
    });
  };

  const reconcileOnce = async (): Promise<void> => {
    if (stopped) return;
    const at = options.now();
    const phase = resolveHostPowerPhase(config, at);
    recordPhase(phase, at);
    if (config.mode === "off") {
      lastDegradedKey = undefined;
      options.keepAwake.release();
      if (assertionHeld !== false) {
        assertionHeld = false;
        recordEvent({ at, kind: "keep-awake-released" });
      }
      return;
    }
    if (config.mode === "always" || phase === "service" || phase === "wake-warmup") {
      lastDelayKey = undefined;
      await acquireOrNotify(at);
      return;
    }
    try {
      const protectedWork = await options.hasProtectedWork();
      if (isStopped()) return;
      if (protectedWork.active) {
        const reasons = [...new Set(protectedWork.reasons)].sort();
        const delayKey = reasons.join("\0");
        if (lastDelayKey !== delayKey) {
          recordEvent({ at, kind: "quiet-release-delayed", reasons });
          lastDelayKey = delayKey;
          log.info("quiet-hours release delayed for protected work", {
            data: { reasons },
          });
        }
        await acquireOrNotify(at);
        return;
      }
      const schedule = options.inspectSchedule();
      if (schedule.status !== "verified") {
        await failAwake(`${schedule.status}: ${schedule.detail}`, at);
        return;
      }
      lastDegradedKey = undefined;
      lastDelayKey = undefined;
      options.keepAwake.release();
      if (assertionHeld !== false) {
        assertionHeld = false;
        recordEvent({ at, kind: "keep-awake-released" });
      }
    } catch (error) {
      await failAwake(`protected-work probe failed: ${safeError(error)}`, at);
    }
  };

  const reconcile = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = reconcileOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    reconcile,
    start(): void {
      if (timer || stopped) return;
      void reconcile();
      if (config.mode !== "scheduled") return;
      timer = options.setInterval(() => void reconcile(), POWER_RECONCILE_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) options.clearInterval(timer);
      timer = undefined;
      options.keepAwake.stop();
    },
  };
}

export function startHostPowerManager(deps: HandlerDeps): () => void {
  const manager = createHostPowerManager(deps.config.hostPower, {
    now: Date.now,
    keepAwake: createKeepAwakeController(),
    hasProtectedWork: createProtectedWorkProbe(deps),
    inspectSchedule: () => inspectPowerSchedule(deps.config.hostPower),
    readPowerSource: readMacPowerSource,
    notifyDegraded: async (reason, delivery) => {
      await deps.notifications.notify({
        level: "warning",
        title: "Power setup needs attention",
        body: `${concisePowerReason(reason)} · run tcb power status`,
        source: "tmux-claude-bot",
        delivery:
          delivery.window === undefined
            ? { mode: "state-change", topic: delivery.topic, state: delivery.state }
            : {
                mode: "once-per-window",
                topic: delivery.topic,
                window: delivery.window,
                state: delivery.state,
              },
      });
    },
    recordEvent: createPowerEventRecorder(),
    setInterval: (tick, delayMs) => setInterval(tick, delayMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  manager.start();
  return () => manager.stop();
}

function quietCycleKey(config: HostPowerConfig, at: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function concisePowerReason(reason: string): string {
  if (reason.startsWith("missing:")) return "daily wake is not installed";
  if (reason.startsWith("conflict:")) return "daily wake conflicts with another schedule";
  if (reason.startsWith("dynamic-offset:")) return "daily wake does not match the configured time";
  if (reason.startsWith("error:")) return "wake schedule could not be verified";
  if (reason.startsWith("protected-work probe failed")) return "active-work safety check failed";
  if (reason.includes("caffeinate assertion could not be acquired"))
    return "keep-awake could not start";
  return "power policy could not be verified";
}
