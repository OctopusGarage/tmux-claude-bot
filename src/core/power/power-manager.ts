import type { HostPowerConfig } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { HandlerDeps } from "../deps.js";
import { createKeepAwakeController, type KeepAwakeController } from "../platform/keep-awake.js";
import { resolveHostPowerPhase } from "../platform/power-policy.js";
import { inspectPowerSchedule, type PowerScheduleInspection } from "../platform/power-schedule.js";
import { type MacPowerSource, readMacPowerSource } from "../platform/power-source.js";
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
  notifyDegraded(reason: string): Promise<void>;
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
  let lastDegradedReason: string | undefined;
  const isStopped = (): boolean => stopped;

  const notifyDegradation = async (reason: string): Promise<void> => {
    if (reason === lastDegradedReason) return;
    lastDegradedReason = reason;
    log.warn("scheduled natural sleep is degraded; failing awake", { data: { reason } });
    await options.notifyDegraded(reason).catch((error) => {
      log.warn("power degradation notification failed", { err: safeError(error) });
    });
  };

  const acquireOrNotify = async (): Promise<void> => {
    if (!options.keepAwake.acquire()) {
      await notifyDegradation("caffeinate assertion could not be acquired");
      return;
    }
    let source: MacPowerSource = "unknown";
    try {
      source = options.readPowerSource();
    } catch (error) {
      await notifyDegradation(`power-source probe failed: ${safeError(error)}`);
      return;
    }
    if (source === "battery") {
      await notifyDegradation("host is on battery; caffeinate -s does not prevent system sleep");
      return;
    }
    lastDegradedReason = undefined;
  };

  const failAwake = async (reason: string): Promise<void> => {
    const acquired = options.keepAwake.acquire();
    let fullReason = acquired ? reason : `${reason}; caffeinate assertion could not be acquired`;
    try {
      if (options.readPowerSource() === "battery") {
        fullReason += "; host is on battery and the AC-only caffeinate assertion is ineffective";
      }
    } catch (error) {
      fullReason += `; power-source probe failed: ${safeError(error)}`;
    }
    await notifyDegradation(fullReason);
  };

  const reconcileOnce = async (): Promise<void> => {
    if (stopped) return;
    const phase = resolveHostPowerPhase(config, options.now());
    if (config.mode === "off") {
      lastDegradedReason = undefined;
      options.keepAwake.release();
      return;
    }
    if (config.mode === "always" || phase === "service" || phase === "wake-warmup") {
      await acquireOrNotify();
      return;
    }
    try {
      const protectedWork = await options.hasProtectedWork();
      if (isStopped()) return;
      if (protectedWork.active) {
        await acquireOrNotify();
        log.info("quiet-hours release delayed for protected work", {
          data: { reasons: protectedWork.reasons },
        });
        return;
      }
      const schedule = options.inspectSchedule();
      if (schedule.status !== "verified") {
        await failAwake(`${schedule.status}: ${schedule.detail}`);
        return;
      }
      lastDegradedReason = undefined;
      options.keepAwake.release();
    } catch (error) {
      await failAwake(`protected-work probe failed: ${safeError(error)}`);
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
    notifyDegraded: async (reason) => {
      await deps.notifications.notify({
        level: "warning",
        title: "Host power policy degraded",
        body: `${reason}. Run tcb power status${deps.config.hostPower.mode === "scheduled" ? " and resolve any wake-schedule finding before the quiet window" : ""}.`,
        source: "tmux-claude-bot",
      });
    },
    setInterval: (tick, delayMs) => setInterval(tick, delayMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  manager.start();
  return () => manager.stop();
}
