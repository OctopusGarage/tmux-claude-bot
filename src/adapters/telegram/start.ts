import { type FileFlavor, hydrateFiles } from "@grammyjs/files";
import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import nodeFetch from "node-fetch";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { markCleanShutdown } from "../../core/infra/lifecycle.js";
import { logger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { createAuthGuard } from "./auth.js";
import { BOT_COMMANDS } from "./commands.js";
import { registerHandlers } from "./handlers.js";
import { createReplyTargetMap } from "./reply-target.js";
import { createRouteHealthStore, type RouteName } from "./transport/route-health.js";
import { createSmartFetch, type SmartFetchRoute } from "./transport/smart-fetch.js";
import { registerVoiceHandler } from "./voice-handler.js";

type MyContext = FileFlavor<Context>;

/**
 * Set up and run the Telegram adapter on the shared core. Verifies connectivity,
 * registers handlers, and hands control to grammy's long-poll loop — which
 * blocks until the bot is stopped (SIGINT/SIGTERM, wired here). Requires
 * `deps.config.telegramBotToken`; the caller only invokes this when Telegram is enabled.
 */
export async function startTelegram(
  deps: HandlerDeps,
  opts: { recoveredFromCrash?: boolean } = {},
): Promise<void> {
  const { config, queue } = deps;

  // Dual-route transport: race proxy vs. direct, learn which is faster/healthier,
  // and fail over when one degrades (the proxy intermittently drops TLS). Direct
  // is always available; the proxy route is added only when configured.
  const routes: SmartFetchRoute[] = [];
  if (config.telegramHttpProxy) {
    const agent = new HttpsProxyAgent(config.telegramHttpProxy);
    routes.push({
      name: "proxy",
      fetch: (url, init) =>
        nodeFetch(url as string, { ...init, agent } as Record<string, unknown>) as Promise<unknown>,
    });
  }
  routes.push({
    name: "direct",
    fetch: (url, init) =>
      nodeFetch(url as string, { ...init } as Record<string, unknown>) as Promise<unknown>,
  });
  const defaultRoute: RouteName = config.telegramHttpProxy ? "proxy" : "direct";
  const routeHealth = createRouteHealthStore({
    filePath: ".queue/route_health.json",
    available: routes.map((r) => r.name),
    defaultRoute,
  });
  const smartFetch = createSmartFetch({
    routes,
    health: routeHealth,
    timeoutMs: 5000,
    isLongPoll: (url) => url.includes("/getUpdates"),
  });
  console.log(
    `[bot] transport routes: ${routes.map((r) => r.name).join(", ")} (default: ${defaultRoute})`,
  );

  // smartFetch wraps node-fetch, whose fetch type differs nominally from grammy's
  // DOM fetch type; the runtime contract (url, init) -> Response is identical.
  const botOptions = {
    client: {
      fetch: smartFetch as any,
    },
  };
  const bot = new Bot<MyContext>(config.telegramBotToken, botOptions);
  bot.api.config.use(hydrateFiles(config.telegramBotToken));

  // Authorization gate: drop updates from non-allowlisted users before any
  // handler runs. Without this the bot drives Claude for anyone who finds it.
  bot.use(createAuthGuard(config.telegramAllowedUserIds));
  if (config.telegramAllowedUserIds.size === 0) {
    console.warn("[bot] TELEGRAM_ALLOWED_USER_IDS is empty — the bot will reject ALL messages.");
  }

  // Catch any error thrown inside a handler so a transient Telegram/network blip
  // is logged instead of becoming an uncaughtException that exits the process.
  bot.catch((err) => {
    console.error(`[bot] handler error on update ${err.ctx.update.update_id}:`, err.error);
  });

  // One reply-target map (TG message id → session) shared by both handler sets.
  const replyTarget = createReplyTargetMap();
  // Order matters: registerVoiceHandler MUST run before registerHandlers (whose
  // catch-all `message:text` forwards any text — commands included — to Claude).
  registerVoiceHandler(bot as any, deps, replyTarget);
  registerHandlers(bot as any, deps, replyTarget);

  try {
    await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: "all_private_chats" } });
    console.log(`[bot] Registered ${BOT_COMMANDS.length} commands to Telegram`);
  } catch (err) {
    console.error("[bot] Failed to set commands:", err instanceof Error ? err.message : err);
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping bot after ${signal}`);
    markCleanShutdown();
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    queue.flushPending();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  console.log("[bot] Starting bot...");
  // Verify Telegram connectivity with exponential backoff.
  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const me = await bot.api.getMe();
      console.log(`[bot] Connected to Telegram as @${me.username} (bot ID: ${me.id})`);
      break;
    } catch (err) {
      const delayMs = Math.min(1000 * 2 ** i, 30000);
      console.error(
        `[bot] Failed to connect (attempt ${i + 1}/${maxRetries}): ${err instanceof Error ? err.message : err}. Retrying in ${delayMs}ms...`,
      );
      if (i === maxRetries - 1) {
        console.error("[bot] Max retries exceeded, exiting.");
        process.exit(1);
      }
      await sleep(delayMs);
    }
  }

  // launchd KeepAlive restarts crashes silently — after an unclean exit, tell the
  // owner the bot auto-recovered (repeated alerts = a crash-loop to investigate).
  // Best-effort; never blocks startup. Disable with TCB_STARTUP_NOTIFY=0.
  if (opts.recoveredFromCrash && process.env.TCB_STARTUP_NOTIFY !== "0") {
    const owner = [...config.telegramAllowedUserIds][0];
    if (owner !== undefined) {
      try {
        await bot.api.sendMessage(
          owner,
          messages("telegram").crashRecovered(new Date().toLocaleString()),
        );
      } catch (err) {
        logger.warn(`[bot] owner crash-alert failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  await bot.start();
  console.log("[bot] Bot started successfully");
}
