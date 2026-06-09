import { type FileFlavor, hydrateFiles } from "@grammyjs/files";
import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import nodeFetch from "node-fetch";
import { createAuthGuard } from "./bot/auth.js";
import { BOT_COMMANDS } from "./bot/commands.js";
import { registerHandlers } from "./bot/handlers.js";
import { registerVoiceHandler } from "./bot/voice-handler.js";
import { claudeBinFromStartCommand, loadConfig } from "./config.js";
import { ClaudeRunner } from "./services/claude.js";
import { createConfigResolver, createExecProbe } from "./services/claude-config-resolver.js";
import { DEFAULT_CONFIG_ROOT } from "./services/history.js";
import { OutputProcessor } from "./services/output.js";
import { createProjectManager, getPathBySession } from "./services/project-manager.js";
import { MessageQueue } from "./services/queue.js";
import { createReplyTargetMap } from "./services/reply-target.js";
import { createRouteHealthStore, type RouteName } from "./services/route-health.js";
import { createSmartFetch, type SmartFetchRoute } from "./services/smart-fetch.js";
import { TmuxBridge } from "./services/tmux.js";
import { sleep } from "./utils/sleep.js";

const AUTO_START_DELAY_MS = 1000;

const config = loadConfig();
const { currentProject } = createProjectManager(process.cwd());

const bridge = new TmuxBridge({
  getSessionName: () => currentProject.get().then((s) => s ?? "claude_telegram_bot"),
  projectSessionPrefix: config.projectSessionPrefix,
});

const output = new OutputProcessor({
  maxOutputLines: config.maxOutputLines,
  maxMessageLength: config.maxMessageLength,
});
const queue = new MessageQueue(config.maxQueueSize);
// Per-session resolver for each tmux pane's claude config dir (history root),
// since different panes may run claude with a different CLAUDE_CONFIG_DIR.
const configResolver = createConfigResolver(createExecProbe(), {
  defaultRoot: DEFAULT_CONFIG_ROOT,
  claudeBin: claudeBinFromStartCommand(config.claudeStartCommand),
  ttlMs: 60_000,
});
const claude = new ClaudeRunner({
  bridge,
  output,
  configResolver,
  claudeCommand: config.claudeStartCommand,
  idlePollTicks: config.idlePollTicks,
  pollIntervalMs: config.pollIntervalMs,
  maxWaitReadyMs: config.maxWaitReadyMs,
  maxWaitDoneMs: config.maxWaitDoneMs,
});

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

// Dual-route transport: race proxy vs. direct, learn which is faster/healthier,
// and fail over when one degrades (the proxy intermittently drops TLS). Direct
// is always available; the proxy route is added only when configured.
const routes: SmartFetchRoute[] = [];
if (config.httpProxy) {
  const agent = new HttpsProxyAgent(config.httpProxy);
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
const defaultRoute: RouteName = config.httpProxy ? "proxy" : "direct";
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
type MyContext = FileFlavor<Context>;
const bot = new Bot<MyContext>(config.botToken, botOptions);
bot.api.config.use(hydrateFiles(config.botToken));

// Authorization gate: drop updates from non-allowlisted users before any
// handler runs. Without this the bot drives Claude for anyone who finds it.
bot.use(createAuthGuard(config.allowedUserIds));
if (config.allowedUserIds.size === 0) {
  console.warn("[bot] ALLOWED_USER_IDS is empty — the bot will reject ALL messages.");
}

// Catch any error thrown inside a handler so a transient Telegram/network blip
// (e.g. ECONNRESET on answerCallbackQuery) is logged instead of becoming an
// uncaughtException that exits the process — which would also redeliver the
// unconfirmed update on restart and crash-loop.
bot.catch((err) => {
  const e = err.error;
  console.error(`[bot] handler error on update ${err.ctx.update.update_id}:`, e);
});

// One reply-target map (TG message id → session) shared by both handler sets.
const replyTarget = createReplyTargetMap();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerHandlers(
  bot as any,
  { bridge, queue, claude, output, config, currentProject, configResolver },
  replyTarget,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerVoiceHandler(
  bot as any,
  { bridge, queue, claude, output, config, currentProject, configResolver },
  replyTarget,
);

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

process.on("uncaughtException", (err) => {
  console.error(`[fatal] uncaughtException: ${err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] unhandledRejection: ${reason instanceof Error ? reason.message : reason}`);
});

await init();
console.log("[bot] Starting bot...");
// Verify Telegram connectivity with exponential backoff
const maxRetries = 5;
let me: Awaited<ReturnType<typeof bot.api.getMe>> | undefined;
for (let i = 0; i < maxRetries; i++) {
  try {
    me = await bot.api.getMe();
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
await bot.start();
console.log("[bot] Bot started successfully");
