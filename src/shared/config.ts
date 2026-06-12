import { config as loadEnv } from "dotenv";
import { z } from "zod";
import type { AppConfig, ScriptConfig } from "./types.js";

/**
 * A positive-integer env var that tolerates a *blank* value. A stray `KEY=`
 * line makes dotenv inject `""`, which counts as present — so a plain
 * `.default()` is skipped, `coerce("")` becomes `0`, and `.positive()` throws,
 * taking down startup with a cryptic ZodError. Treating `""` as unset lets the
 * default apply (same rationale as `LARK_DOMAIN.catch` below). A non-empty but
 * non-numeric value still throws — that's a real typo worth surfacing.
 */
const blankTolerantPositiveInt = (def: number): z.ZodType<number> =>
  z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().default(def));

// Exported so the docs contract test can assert every supported key is
// documented in .env.example (legacy aliases excepted).
export const envSchema = z.object({
  // Optional: Telegram is enabled only when a token is present. A Feishu/Lark-only
  // install (LARK_* configured) needs no Telegram token.
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  BOT_TOKEN: z.string().default(""), // legacy alias (pre-multi-protocol); read as fallback
  CLAUDE_START_COMMAND: z.string().min(1).default("claude-yolo"),
  IDLE_POLL_TICKS: blankTolerantPositiveInt(5),
  POLL_INTERVAL_MS: blankTolerantPositiveInt(1000),
  MAX_OUTPUT_LINES: blankTolerantPositiveInt(200),
  MAX_MESSAGE_LENGTH: blankTolerantPositiveInt(3500),
  // Inbound cap is the size of a prompt we accept FROM the user and forward TO
  // Claude. It is decoupled from MAX_MESSAGE_LENGTH (which only truncates
  // replies). Telegram never delivers a single message over 4096 chars, so the
  // default effectively never rejects a legitimate prompt.
  MAX_INBOUND_LENGTH: blankTolerantPositiveInt(4096),
  RATE_LIMIT_MS: blankTolerantPositiveInt(2000),
  SESSION_WARMUP_MS: blankTolerantPositiveInt(500),
  MAX_QUEUE_SIZE: blankTolerantPositiveInt(30),
  MAX_WAIT_READY_MS: blankTolerantPositiveInt(60000),
  MAX_WAIT_DONE_MS: blankTolerantPositiveInt(300000),
  // Absolute cap on one prompt's wall-clock wait. Each MAX_WAIT_DONE_MS round
  // that expires sends a one-time "still running" notice and keeps waiting,
  // until this total is exhausted — then the run resolves with partial output.
  MAX_WAIT_DONE_TOTAL_MS: blankTolerantPositiveInt(3600000),
  MAX_CONCURRENT_SESSIONS: blankTolerantPositiveInt(5),
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
  // `.catch` (not just `.default`) so a blank/invalid LARK_DOMAIN=... line falls
  // back instead of throwing at startup — a stray Lark line must not take down a
  // Telegram-only install.
  LARK_DOMAIN: z.enum(["feishu", "lark"]).catch("feishu"),
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

/**
 * Derive a short button label for a start command when no explicit
 * `CLAUDE_START_LABEL_n` is set. Prefers the `CLAUDE_CONFIG_DIR` folder name,
 * then `ANTHROPIC_MODEL`, then the binary basename — whichever distinguishes the
 * options (e.g. `CLAUDE_CONFIG_DIR=~/.claude-stella … claude` → `claude-stella`).
 */
export function deriveStartLabel(command: string, idx: number): string {
  const tokens = command.split(/\s+/).filter(Boolean);
  const valOf = (name: string): string | undefined =>
    tokens.find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
  const cfgDir = valOf("CLAUDE_CONFIG_DIR");
  if (cfgDir) {
    // basename, with the leading dot of hidden dirs dropped (.claude-stella → claude-stella)
    const base = cfgDir.replace(/\/+$/, "").split("/").pop()?.replace(/^\.+/, "");
    if (base) return base;
  }
  const model = valOf("ANTHROPIC_MODEL");
  if (model) return model;
  const bin = tokens.find((t) => !/^[A-Za-z_]\w*=/.test(t));
  if (bin) return bin.split("/").pop() ?? bin;
  return `#${idx}`;
}

/**
 * Build the selectable start-command list from the env: `CLAUDE_START_COMMAND`
 * (primary) plus contiguous `CLAUDE_START_COMMAND_2..N`, each with an optional
 * friendly `CLAUDE_START_LABEL_n` (falls back to {@link deriveStartLabel}).
 */
export function parseStartCommands(
  env: NodeJS.ProcessEnv,
  primary: string,
): { label: string; command: string }[] {
  const out: { label: string; command: string }[] = [];
  const add = (command: string | undefined, labelKey: string, idx: number): void => {
    const cmd = command?.trim();
    if (!cmd) return;
    out.push({ label: env[labelKey]?.trim() || deriveStartLabel(cmd, idx), command: cmd });
  };
  add(primary, "CLAUDE_START_LABEL", 1);
  for (let i = 2; ; i++) {
    const cmd = env[`CLAUDE_START_COMMAND_${i}`];
    if (cmd === undefined) break; // stop at the first gap
    add(cmd, `CLAUDE_START_LABEL_${i}`, i);
  }
  return out;
}

/**
 * Load `.env` into process.env. Honors `TCB_ENV_FILE` so `npm run dev` can borrow
 * the deployed (prod) config — develop against the real token/proxy/Feishu with
 * hot reload, with no second `.env` to drift. Defaults to `./.env`.
 */
function loadEnvFile(): void {
  const path = process.env.TCB_ENV_FILE;
  loadEnv(path ? { path } : undefined);
}

export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig {
  if (!env) {
    loadEnvFile();
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
    startCommands: parseStartCommands(env, parsed.CLAUDE_START_COMMAND),
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
    maxWaitDoneTotalMs: parsed.MAX_WAIT_DONE_TOTAL_MS,
    maxConcurrentSessions: parsed.MAX_CONCURRENT_SESSIONS,
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
  SESSION_WARMUP_MS: blankTolerantPositiveInt(500),
  PROJECT_SESSION_PREFIX: z.string().min(1).default("tmux_proj_"),
});

export function loadScriptConfig(env?: NodeJS.ProcessEnv): ScriptConfig {
  if (!env) {
    loadEnvFile();
    env = process.env;
  }
  const parsed = scriptEnvSchema.parse(env);

  return {
    claudeStartCommand: parsed.CLAUDE_START_COMMAND,
    sessionWarmupMs: parsed.SESSION_WARMUP_MS,
    projectSessionPrefix: parsed.PROJECT_SESSION_PREFIX,
  };
}
