import { config as loadEnv } from "dotenv";
import { z } from "zod";
import type { AppConfig, ScriptConfig } from "./types.js";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1),
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
  ALLOWED_USER_IDS: z.string().default(""),
  CD_ALLOWED_DIRS: z.string().default(""),
  PROJECT_SESSION_PREFIX: z.string().min(1).default("tmux_proj_"),
  HTTP_PROXY: z.string().optional(),
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

  return {
    botToken: parsed.BOT_TOKEN,
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
    allowedUserIds: new Set(
      parsed.ALLOWED_USER_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    cdAllowedDirs: parsed.CD_ALLOWED_DIRS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    projectSessionPrefix: parsed.PROJECT_SESSION_PREFIX,
    httpProxy: parsed.HTTP_PROXY,
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
