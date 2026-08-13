import { startControlServer } from "./adapters/control/server.js";
import { startLark } from "./adapters/lark/start.js";
import { startTelegram } from "./adapters/telegram/start.js";
import { bootstrap } from "./bootstrap.js";
import { reconcileAndResumeActiveDelegatedTasksAfterRestart } from "./core/autopilot/delegated-task.js";
import {
  acquireInstanceLock,
  InstanceLockHeldError,
  releaseInstanceLock,
} from "./core/infra/instance-lock.js";
import { detectUncleanRestart, markCleanShutdown } from "./core/infra/lifecycle.js";
import { startLoopEngineering } from "./core/loop/service.js";
import { startLoopSupervisors } from "./core/loop/supervisor-session.js";
import { startLongTaskMonitor } from "./core/notifications/long-task-monitor.js";
import { managedRestartCommand } from "./core/platform/service-hints.js";
import { startHostPowerManager } from "./core/power/power-manager.js";
import { startOperator } from "./core/projects/operator-home.js";
import { getPathBySession } from "./core/projects/sessionPathMap.js";
import { autoRecoverOnBoot } from "./core/recovery/recover.js";
import { startRunningSweep } from "./core/recovery/running-sweep.js";
import { startSessionIdleReaper } from "./core/recovery/session-idle-reaper.js";
import { startResourceGuardian } from "./core/resource-guardian/service.js";
import { startRuntimeGuardian } from "./core/runtime-guardian/service.js";
import { startDailyTaskAudit } from "./core/tasks/daily-audit-service.js";
import { createLogger } from "./shared/utils/logger.js";
import { sleep } from "./shared/utils/sleep.js";

const AUTO_START_DELAY_MS = 1000;
// Delay auto-recovery a few seconds after boot so init()/adapters settle first.
const AUTO_RECOVER_DELAY_MS = 5000;

const log = createLogger("boot");
const fatalLog = createLogger("index");
let shuttingDown = false;
let stopResourceGuardian = (): void => {};
let stopHostPowerManager = (): void => {};

// Refuse to start beside another running instance — two pollers on one
// Telegram token 409 each other. See core/instance-lock.ts and CLAUDE.md
// ("Process Management") for the launchd KeepAlive trap this guards against.
try {
  acquireInstanceLock();
  log.info("instance lock acquired", { data: { pid: process.pid } });
} catch (err) {
  if (err instanceof InstanceLockHeldError) {
    log.error(
      `${err.message}. If that instance is the managed service, restart it with ` +
        `\`${managedRestartCommand()}\` instead of starting a second copy.`,
    );
    process.exit(1);
  }
  throw err;
}

const deps = bootstrap();
const { config, currentProject, bridge } = deps;

async function init(): Promise<void> {
  // Restore every channel's current session (Telegram + Feishu may differ).
  const sessions = await currentProject.allCurrent();
  if (sessions.length === 0) {
    log.info("No current project for any channel, skipping auto-start.");
    return;
  }
  let recreated = 0;
  for (const session of sessions) {
    try {
      const alive = await bridge.isPaneAlive(session);
      if (!alive) {
        recreated++;
        log.info(`Session ${session} not alive, creating...`);
        // Start the pane directly in the mapped directory (-c) — no typed `cd`.
        const projectPath = getPathBySession(session);
        await bridge.createSession(session, projectPath ?? undefined);
        await sleep(AUTO_START_DELAY_MS);
        if (projectPath) {
          log.info(`Restored directory: ${projectPath}`);
        }
      }
    } catch (err) {
      log.error(`init failed for ${session}`, { err });
    }
  }
  log.info("current-session restore complete", {
    data: { channels: sessions.length, recreated },
  });
  // Auto-starting Claude on boot is disabled by design: the bot must never type a
  // start command into a pane on its own — EXCEPT reboot recovery (AUTO_RECOVER),
  // which only restores agents the user already had running, resuming their
  // conversation. A fresh project still requires an explicit /start.
  log.info("Auto-start disabled — use /start to launch Claude.");
}

// Did the previous run exit cleanly? If not, launchd auto-recovered a crash —
// the adapters alert the owner once connected. Clean shutdowns clear the marker.
const recoveredFromCrash = detectUncleanRestart();
function noteShutdownSignal(signal: "SIGINT" | "SIGTERM"): void {
  shuttingDown = true;
  log.info("shutdown signal received", { data: { signal } });
}

process.once("SIGINT", () => noteShutdownSignal("SIGINT"));
process.once("SIGTERM", () => noteShutdownSignal("SIGTERM"));
process.once("SIGINT", markCleanShutdown);
process.once("SIGTERM", markCleanShutdown);
process.once("SIGINT", releaseInstanceLock);
process.once("SIGTERM", releaseInstanceLock);
process.once("SIGINT", () => stopHostPowerManager());
process.once("SIGTERM", () => stopHostPowerManager());
process.once("SIGINT", () => stopResourceGuardian());
process.once("SIGTERM", () => stopResourceGuardian());

process.on("uncaughtException", (err) => {
  if (shuttingDown && isAbortLikeError(err)) {
    fatalLog.info(`ignored shutdown abort: ${err.message}`);
    return;
  }
  fatalLog.error(`uncaughtException: ${err.stack ?? err.message}`);
  process.exit(1); // launchd restarts → startup flags the unclean exit → owner alert
});
process.on("unhandledRejection", (reason) => {
  fatalLog.error(
    `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`,
  );
});

function isAbortLikeError(err: unknown): err is Error {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

// Each adapter is independently optional: Telegram is on when TELEGRAM_BOT_TOKEN is
// set, Feishu/Lark when LARK_* is configured. LARK_ONLY forces Feishu-only even with
// a token (handy for debugging the Lark adapter in isolation).
const telegramEnabled = Boolean(config.telegramBotToken) && process.env.LARK_ONLY !== "true";
const larkEnabled = Boolean(config.lark);

if (!telegramEnabled && !larkEnabled) {
  log.error(
    "No chat adapter configured. Set TELEGRAM_BOT_TOKEN for Telegram and/or run `npm run setup:lark` for Feishu/Lark, then restart.",
  );
  process.exit(1);
}

await init();

// Keep the reboot-recovery "running sessions" roster in sync with live tmux, so
// sessions started/exited directly in tmux (outside the bot) are tracked too.
startRunningSweep(deps, config.runningSweepMs);
startSessionIdleReaper(deps, config.sessionIdleReaper);

let loopStartupReady = true;
try {
  await startLoopEngineering(deps, config.loopEngineering);
} catch (err) {
  loopStartupReady = false;
  log.error("loop engineering startup reconciliation failed; automatic recovery remains paused", {
    err,
  });
}
// Boot the background Loop Supervisor session. No-op unless explicitly enabled.
void startLoopSupervisors(deps);
// Active delegation recovery must observe the Loop startup barrier. Otherwise a
// restart can resume a WorkOrder before its already-written final summary has
// been reconciled and settled.
if (loopStartupReady) {
  try {
    await reconcileAndResumeActiveDelegatedTasksAfterRestart(deps);
  } catch (err) {
    log.error("active delegation startup recovery failed", { err });
  }
}
// Boot the home operator session (provision home dir + create session + start agent).
// Fire-and-forget — must not block boot. No-op when HOME_OPERATOR_ENABLED=false.
void startOperator(deps);

// Restore the agents that were running before a machine reboot, automatically.
// Delayed + fire-and-forget so boot isn't held up by N agent launches; idempotent
// (a no-op when tmux survived a plain bot restart).
if (config.autoRecover) {
  (
    setTimeout(() => void autoRecoverOnBoot(deps), AUTO_RECOVER_DELAY_MS) as { unref?: () => void }
  ).unref?.();
}

// Local control transport for the terminal TUI — a unix socket that drives this
// same bot (one queue, no races). Non-blocking; best-effort.
startControlServer(deps);

let notificationDrivenServicesStarted = false;
const startNotificationDrivenServices = (): void => {
  if (notificationDrivenServicesStarted) return;
  notificationDrivenServicesStarted = true;
  stopHostPowerManager = startHostPowerManager(deps);
  stopResourceGuardian = startResourceGuardian(deps);
  startRuntimeGuardian(deps);
  startDailyTaskAudit(deps);
  startLongTaskMonitor(deps);
};

// Lark connects over a WebSocket (non-blocking); start it first. No-op unless
// config.lark is set.
startLark(deps, { recoveredFromCrash });

if (telegramEnabled) {
  // grammy's long-poll loop blocks until the bot is stopped; this runs last.
  await startTelegram(deps, {
    recoveredFromCrash,
    onNotificationsReady: startNotificationDrivenServices,
  });
  startNotificationDrivenServices();
} else {
  startNotificationDrivenServices();
  // Feishu-only: the Lark WS keeps the process alive. Wire a minimal shutdown.
  log.info("Telegram disabled — running Feishu (Lark) only. Ctrl-C to stop.");
  const stop = (): void => {
    markCleanShutdown();
    deps.queue.flushPending();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
