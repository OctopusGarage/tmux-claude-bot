import { type FileFlavor, hydrateFiles } from "@grammyjs/files";
import { Bot, type Context, GrammyError } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import nodeFetch from "node-fetch";
import { renderNotice } from "../../core/autopilot/notifier.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { markCleanShutdown } from "../../core/infra/lifecycle.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { newTraceId, runWithLogContext } from "../../shared/utils/log-context.js";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { createAuthGuard } from "./auth.js";
import { BOT_COMMANDS } from "./commands.js";
import { registerHandlers } from "./handlers.js";
import { buildAutopilotGateKeyboard } from "./keyboards.js";
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
const log = createLogger("telegram.start");

/**
 * Whether a long-poll error is fatal (no amount of retrying helps) vs. transient.
 * Only an authentication failure — 401 (bad/revoked token) or 404 (wrong token /
 * bot deleted) — is fatal. Everything else is treated as transient and retried:
 * a 409 Conflict (a dropped long-poll still lingering server-side, or a duplicate
 * — local duplicates are already prevented by the instance lock), 5xx, and network
 * hang-ups (HttpError) all clear on their own, so the supervised loop should wait
 * them out rather than crash the process.
 */
export function isFatalPollingError(err: unknown): boolean {
  return err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404);
}

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
  log.info(`transport routes: ${routes.map((r) => r.name).join(", ")} (default: ${defaultRoute})`);

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
    log.warn("TELEGRAM_ALLOWED_USER_IDS is empty — the bot will reject ALL messages.");
  }

  // Catch any error thrown inside a handler so a transient Telegram/network blip
  // is logged instead of becoming an uncaughtException that exits the process.
  // Then surface a generic error to the user — every message must get a reply
  // (parity with Lark's makeMessageHandler boundary; terminal output is invisible
  // to the user). Best-effort: a failed reply (e.g. no chat on this update) must
  // not re-throw out of the catch.
  bot.catch(async (err) => {
    log.error(`handler error on update ${err.ctx.update.update_id}`, { err: err.error });
    try {
      await err.ctx.reply(messages("telegram").handlerError);
    } catch (replyErr) {
      log.error(`failed to send handler-error reply: ${String(replyErr)}`);
    }
  });

  // Open a log context per update (after the auth guard, so dropped updates
  // don't mint a trace), before any handler runs — so all logs during parse and
  // routing share one traceId.
  bot.use((ctx, next) =>
    runWithLogContext(
      {
        traceId: newTraceId(),
        channel: "telegram",
        ...(ctx.chat?.id !== undefined && { chatId: ctx.chat.id }),
      },
      () => next(),
    ),
  );

  // One reply-target map (TG message id → session) shared by both handler sets.
  const replyTarget = createReplyTargetMap();
  // Order matters: registerVoiceHandler MUST run before registerHandlers (whose
  // catch-all `message:text` forwards any text — commands included — to Claude).
  registerVoiceHandler(bot as any, deps, replyTarget);
  registerHandlers(bot as any, deps, replyTarget);

  try {
    await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: "all_private_chats" } });
    log.info(`Registered ${BOT_COMMANDS.length} commands to Telegram`);
  } catch (err) {
    log.error("Failed to set commands", { err });
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Stopping bot after ${signal}`);
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

  log.info("Starting bot...");
  // Best-effort connectivity probe — for a clean "Connected as @…" log and to
  // surface a bad token early. It is NOT a gate: if Telegram is unreachable (the
  // proxy/route is down, a network blip), we do NOT exit the process. The
  // supervised long-poll loop below keeps retrying Telegram in-process while the
  // control transport (TUI/CLI) and Lark — already started — stay up. A Telegram
  // or network outage must never take down the rest of the bot.
  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const me = await bot.api.getMe();
      log.info(`Connected to Telegram as @${me.username} (bot ID: ${me.id})`);
      break;
    } catch (err) {
      if (isFatalPollingError(err)) {
        const code = err instanceof GrammyError ? err.error_code : "?";
        log.error(
          `Telegram token rejected (${code}) — leaving Telegram off; Lark / TUI / CLI keep running. Fix the token and restart.`,
          { err },
        );
        return; // bad token: don't poll, but keep the process alive for the other surfaces
      }
      const delayMs = Math.min(1000 * 2 ** i, 30000);
      log.warn(
        `Telegram not reachable (attempt ${i + 1}/${maxRetries}): ${err instanceof Error ? err.message : err}. Retrying in ${delayMs}ms...`,
      );
      if (i === maxRetries - 1) {
        log.warn(
          "Telegram still unreachable — continuing without it; the long-poll loop keeps retrying in the background. Lark / TUI / CLI are unaffected.",
        );
        break; // proceed to the supervised loop (it keeps retrying); never exit the process
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
        log.warn(`owner crash-alert failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Register the Telegram owner as the proactive-notification channel so the
  // autopilot (and any other notifier.broadcast caller) can DM the owner.
  const owner = [...config.telegramAllowedUserIds][0];
  if (owner !== undefined) {
    deps.notifier.register((notice) => {
      const text = renderNotice(notice, messages("telegram"));
      const reply_markup =
        notice.kind === "awaitHuman"
          ? buildAutopilotGateKeyboard(sessionShortId(notice.session))
          : undefined;
      return bot.api.sendMessage(owner, text, reply_markup ? { reply_markup } : {}).then(() => {});
    });
  }

  // grammy's long-poll loop blocks until the bot is stopped. Through a flaky
  // proxy, getUpdates fails transiently — most often a 409 when a previous
  // long-poll was dropped and still lingers server-side, or a socket hang-up.
  // Crashing the process on those churns: the abandoned long-poll becomes a
  // server-side zombie that 409s the next start, so each restart re-collides.
  // Supervise the loop instead — on a transient error back off and re-enter
  // in-process (which closes the failed request cleanly and lets the zombie
  // expire); only a fatal auth error bubbles out.
  const MAX_BACKOFF_MS = 30_000;
  const HEALTHY_RUN_MS = 60_000; // a run this long was healthy → reset backoff
  let backoffMs = 1000;
  for (;;) {
    const startedAt = Date.now();
    try {
      await bot.start({
        timeout: config.telegramLongpollTimeoutSec,
        onStart: () => log.info("Bot started successfully"),
      });
      return; // resolved → bot.stop() was called (clean shutdown)
    } catch (err) {
      if (stopping) throw err; // clean-shutdown path
      if (isFatalPollingError(err)) {
        // A revoked/invalid token can't be retried away. Stop Telegram but keep
        // the process alive — Lark / TUI / CLI must not die with it.
        log.error(
          "Telegram polling hit a fatal auth error — stopping Telegram; other surfaces continue.",
          {
            err,
          },
        );
        return;
      }
      if (Date.now() - startedAt > HEALTHY_RUN_MS) backoffMs = 1000;
      log.warn(
        `polling error: ${err instanceof Error ? err.message : err} — retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}
