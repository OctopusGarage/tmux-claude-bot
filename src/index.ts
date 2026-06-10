import { startLark } from "./adapters/lark/start.js";
import { startTelegram } from "./adapters/telegram/start.js";
import { bootstrap } from "./bootstrap.js";
import { getPathBySession } from "./core/project-manager.js";
import { sleep } from "./shared/utils/sleep.js";

const AUTO_START_DELAY_MS = 1000;

const deps = bootstrap();
const { config, currentProject, bridge } = deps;

async function init(): Promise<void> {
  const session = await currentProject.get();
  if (!session) {
    console.log("[init] No .current_project found, skipping auto-start.");
    return;
  }
  try {
    const alive = await bridge.isPaneAlive();
    if (!alive) {
      console.log(`[init] Session ${session} not alive, creating...`);
      await bridge.createSession(session);
      await sleep(AUTO_START_DELAY_MS);
      // Restore working directory if mapped
      const projectPath = getPathBySession(session);
      if (projectPath) {
        await bridge.sendKeys(`cd "${projectPath}"`, session);
        await sleep(AUTO_START_DELAY_MS);
        console.log(`[init] Restored directory: ${projectPath}`);
      }
    }
    // Auto-starting Claude on boot is disabled by design: the bot must never
    // type the start command into a pane on its own (it once landed inside an
    // interactive Claude session). Launch Claude explicitly with /start.
    console.log("[init] Auto-start disabled — use /start to launch Claude.");
  } catch (err) {
    console.error("[init] init failed:", err);
  }
}

process.on("uncaughtException", (err) => {
  console.error(`[fatal] uncaughtException: ${err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] unhandledRejection: ${reason instanceof Error ? reason.message : reason}`);
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
startLark(deps);

if (telegramEnabled) {
  // grammy's long-poll loop blocks until the bot is stopped; this runs last.
  await startTelegram(deps);
} else {
  // Feishu-only: the Lark WS keeps the process alive. Wire a minimal shutdown.
  console.log("[bot] Telegram disabled — running Feishu (Lark) only. Ctrl-C to stop.");
  const stop = (): void => {
    deps.queue.flushPending();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
