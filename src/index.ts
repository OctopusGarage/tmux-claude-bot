import { startLark } from "./adapters/lark/start.js";
import { startTelegram } from "./adapters/telegram/start.js";
import { bootstrap } from "./bootstrap.js";
import {
  acquireInstanceLock,
  InstanceLockHeldError,
  releaseInstanceLock,
} from "./core/infra/instance-lock.js";
import { detectUncleanRestart, markCleanShutdown } from "./core/infra/lifecycle.js";
import { managedRestartCommand } from "./core/platform/service-hints.js";
import { getPathBySession } from "./core/projects/sessionPathMap.js";
import { logger } from "./shared/utils/logger.js";
import { sleep } from "./shared/utils/sleep.js";

const AUTO_START_DELAY_MS = 1000;

// Refuse to start beside another running instance — two pollers on one
// Telegram token 409 each other. See core/instance-lock.ts and CLAUDE.md
// ("Process Management") for the launchd KeepAlive trap this guards against.
try {
  acquireInstanceLock();
} catch (err) {
  if (err instanceof InstanceLockHeldError) {
    console.error(
      `[bot] ${err.message}. If that instance is the managed service, restart it with ` +
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
    console.log("[init] No current project for any channel, skipping auto-start.");
    return;
  }
  for (const session of sessions) {
    try {
      const alive = await bridge.isPaneAlive(session);
      if (!alive) {
        console.log(`[init] Session ${session} not alive, creating...`);
        // Start the pane directly in the mapped directory (-c) — no typed `cd`.
        const projectPath = getPathBySession(session);
        await bridge.createSession(session, projectPath ?? undefined);
        await sleep(AUTO_START_DELAY_MS);
        if (projectPath) {
          console.log(`[init] Restored directory: ${projectPath}`);
        }
      }
    } catch (err) {
      console.error(`[init] init failed for ${session}:`, err);
    }
  }
  // Auto-starting Claude on boot is disabled by design: the bot must never type
  // the start command into a pane on its own. Launch Claude explicitly with /start.
  console.log("[init] Auto-start disabled — use /start to launch Claude.");
}

// Did the previous run exit cleanly? If not, launchd auto-recovered a crash —
// the adapters alert the owner once connected. Clean shutdowns clear the marker.
const recoveredFromCrash = detectUncleanRestart();
process.once("SIGINT", markCleanShutdown);
process.once("SIGTERM", markCleanShutdown);
process.once("SIGINT", releaseInstanceLock);
process.once("SIGTERM", releaseInstanceLock);

process.on("uncaughtException", (err) => {
  logger.error(`[fatal] uncaughtException: ${err.stack ?? err.message}`);
  process.exit(1); // launchd restarts → startup flags the unclean exit → owner alert
});
process.on("unhandledRejection", (reason) => {
  logger.error(
    `[fatal] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`,
  );
});

// Each adapter is independently optional: Telegram is on when TELEGRAM_BOT_TOKEN is
// set, Feishu/Lark when LARK_* is configured. LARK_ONLY forces Feishu-only even with
// a token (handy for debugging the Lark adapter in isolation).
const telegramEnabled = Boolean(config.telegramBotToken) && process.env.LARK_ONLY !== "true";
const larkEnabled = Boolean(config.lark);

if (!telegramEnabled && !larkEnabled) {
  console.error(
    "[bot] No chat adapter configured. Set TELEGRAM_BOT_TOKEN for Telegram and/or run `npm run setup:lark` for Feishu/Lark, then restart.",
  );
  process.exit(1);
}

await init();

// Lark connects over a WebSocket (non-blocking); start it first. No-op unless
// config.lark is set.
startLark(deps, { recoveredFromCrash });

if (telegramEnabled) {
  // grammy's long-poll loop blocks until the bot is stopped; this runs last.
  await startTelegram(deps, { recoveredFromCrash });
} else {
  // Feishu-only: the Lark WS keeps the process alive. Wire a minimal shutdown.
  console.log("[bot] Telegram disabled — running Feishu (Lark) only. Ctrl-C to stop.");
  const stop = (): void => {
    markCleanShutdown();
    deps.queue.flushPending();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
