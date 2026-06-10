import { config as loadEnv } from "dotenv";
import { z } from "zod";
import type { AppConfig, ScriptConfig } from "./types.js";

const envSchema = z.object({
  // Optional: Telegram is enabled only when a token is present. A Feishu/Lark-only
  // install (LARK_* configured) needs no Telegram token.
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  BOT_TOKEN: z.string().default(""), // legacy alias (pre-multi-protocol); read as fallback
  CLAUDE_START_COMMAND: z.string().min(1).default("claude-yolo"),
  IDLE_POLL_TICKS: z.coerce.number().int().positive().default(5),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  MAX_OUTPUT_LINES: z.coerce.number().int().positive().default(200),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(3500),
  // Inbound cap is the size of a prompt we accept FROM the user and forward TO
  // Claude. It is decoupled from MAX_MESSAGE_LENGTH (which only truncates
  // replies). Telegram never delivers a single message over 4096 chars, so the
  // default effectively never rejects a legitimate prompt.
  MAX_INBOUND_LENGTH: z.coerce.number().int().positive().default(4096),
  RATE_LIMIT_MS: z.coerce.number().int().positive().default(2000),
  SESSION_WARMUP_MS: z.coerce.number().int().positive().default(500),
  MAX_QUEUE_SIZE: z.coerce.number().int().positive().default(30),
  MAX_WAIT_READY_MS: z.coerce.number().int().positive().default(60000),
  MAX_WAIT_DONE_MS: z.coerce.number().int().positive().default(300000),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  ALLOWED_USER_IDS: z.string().default(""), // legacy alias
  CD_ALLOWED_DIRS: z.string().default(""),
  PROJECT_SESSION_PREFIX: z.string().min(1).default("tmux_proj_"),
  TELEGRAM_HTTP_PROXY: z.string().optional(),
  HTTP_PROXY: z.string().optional(), // legacy alias
  LARK_ENABLED: z.string().default("false"),
  LARK_APP_ID: z.string().default(""),
  LARK_APP_SECRET: z.string().default(""),
  LARK_ALLOWED_OPEN_IDS: z.string().default(""),
  LARK_DOMAIN: z.enum(["feishu", "lark"]).default("feishu"),
});

/**
 * Extract the claude executable from CLAUDE_START_COMMAND, skipping any leading
 * `VAR=value` environment assignments (e.g.
 * `CLAUDE_CONFIG_DIR=… /path/claude --flag` → `/path/claude`). Used to match the
 * running claude process; a bare `.split(" ")[0]` would wrongly pick the env
 * assignment and make process detection never match.
 */
export function claudeBinFromStartCommand(cmd: string): string {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  return tokens.find((t) => !/^[A-Za-z_]\w*=/.test(t)) ?? "claude";
}

export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig {
  if (!env) {
    loadEnv();
    env = process.env;
  }
  const parsed = envSchema.parse(env);

  // Resolve new-or-legacy: the unprefixed keys predate multi-protocol support and
  // are kept as read-only fallbacks so existing .env files keep working.
  const telegramBotToken = parsed.TELEGRAM_BOT_TOKEN || parsed.BOT_TOKEN;
  const telegramHttpProxy = parsed.TELEGRAM_HTTP_PROXY ?? parsed.HTTP_PROXY;
  const telegramAllowedRaw = parsed.TELEGRAM_ALLOWED_USER_IDS || parsed.ALLOWED_USER_IDS;

  const larkEnabled = parsed.LARK_ENABLED === "true";
  const lark =
    larkEnabled && parsed.LARK_APP_ID && parsed.LARK_APP_SECRET
      ? {
          appId: parsed.LARK_APP_ID,
          appSecret: parsed.LARK_APP_SECRET,
          allowedOpenIds: new Set(
            parsed.LARK_ALLOWED_OPEN_IDS.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
          domain: parsed.LARK_DOMAIN,
        }
      : undefined;

  return {
    telegramBotToken,
    claudeStartCommand: parsed.CLAUDE_START_COMMAND,
    idlePollTicks: parsed.IDLE_POLL_TICKS,
    pollIntervalMs: parsed.POLL_INTERVAL_MS,
    maxOutputLines: parsed.MAX_OUTPUT_LINES,
    maxMessageLength: parsed.MAX_MESSAGE_LENGTH,
    maxInboundLength: parsed.MAX_INBOUND_LENGTH,
    rateLimitMs: parsed.RATE_LIMIT_MS,
    sessionWarmupMs: parsed.SESSION_WARMUP_MS,
    maxQueueSize: parsed.MAX_QUEUE_SIZE,
    maxWaitReadyMs: parsed.MAX_WAIT_READY_MS,
    maxWaitDoneMs: parsed.MAX_WAIT_DONE_MS,
    telegramAllowedUserIds: new Set(
      telegramAllowedRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    cdAllowedDirs: parsed.CD_ALLOWED_DIRS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    projectSessionPrefix: parsed.PROJECT_SESSION_PREFIX,
    telegramHttpProxy,
    lark,
  };
}

const scriptEnvSchema = z.object({
  CLAUDE_START_COMMAND: z.string().min(1).default("claude-yolo"),
  SESSION_WARMUP_MS: z.coerce.number().int().positive().default(500),
  PROJECT_SESSION_PREFIX: z.string().min(1).default("tmux_proj_"),
});

export function loadScriptConfig(env?: NodeJS.ProcessEnv): ScriptConfig {
  if (!env) {
    loadEnv();
    env = process.env;
  }
  const parsed = scriptEnvSchema.parse(env);

  return {
    claudeStartCommand: parsed.CLAUDE_START_COMMAND,
    sessionWarmupMs: parsed.SESSION_WARMUP_MS,
    projectSessionPrefix: parsed.PROJECT_SESSION_PREFIX,
  };
}
