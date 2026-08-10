import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { appStateDir, appStateFile } from "./state-dir.js";
import type { AgentKind, AppConfig, ScriptConfig, StartCommand } from "./types.js";

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

/** Like {@link blankTolerantPositiveInt} but allows 0 (e.g. a long-poll timeout
 * of 0 means short polling — getUpdates returns immediately). */
const blankTolerantNonNegativeInt = (def: number): z.ZodType<number> =>
  z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).default(def));

/**
 * A non-empty string env var that tolerates a *blank* value — same trap as
 * {@link blankTolerantPositiveInt}, but for `.string().min(1)`: a stray `KEY=`
 * line injects "", which is present, so `.default()` is skipped and `.min(1)`
 * rejects "" → cryptic ZodError at startup. Treat "" as unset so the default
 * applies (e.g. a blank `CLAUDE_START_COMMAND=` falls back to "claude-yolo").
 */
const blankTolerantString = (def: string): z.ZodType<string> =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).default(def));

const optionalRawEnv = z.preprocess((v) => (v === undefined ? "" : v), z.string().default(""));
const worktreeIsolationSchema = (def: "isolated" | "source" | "auto") =>
  z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["isolated", "source", "auto"]).default(def),
  );

// Exported so the docs contract test can assert every supported key is
// documented in .env.example (legacy aliases excepted).
export const envSchema = z.object({
  // Optional: Telegram is enabled only when a token is present. A Feishu/Lark-only
  // install (LARK_* configured) needs no Telegram token.
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  BOT_TOKEN: z.string().default(""), // legacy alias (pre-multi-protocol); read as fallback
  CLAUDE_START_COMMAND: blankTolerantString("claude-yolo"),
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
  PROJECT_SESSION_PREFIX: blankTolerantString("tmux_proj_"),
  TELEGRAM_HTTP_PROXY: z.string().optional(),
  HTTP_PROXY: z.string().optional(), // legacy alias
  // Long-poll timeout (seconds) for getUpdates. grammy's default is 30. Behind a
  // flaky proxy that drops idle upstream connections after a few seconds, a long
  // hold gets cut mid-poll and the lingering server-side getUpdates then 409s the
  // next call — set this below the proxy's idle cut-off (e.g. 3) so each poll
  // returns cleanly before the drop. 0 = short polling (return immediately).
  TELEGRAM_LONGPOLL_TIMEOUT_SEC: blankTolerantNonNegativeInt(30),
  // How often (ms) to reconcile the reboot-recovery "running sessions" roster
  // against live tmux, so sessions started/exited directly in tmux (bypassing the
  // bot) are tracked too. Default 5 min; 0 disables the sweep.
  RUNNING_SWEEP_MS: blankTolerantNonNegativeInt(300000),
  // How often to close long-idle project agents. Only exits the agent process and
  // keeps tmux/project state so the next use can resume. 0 disables.
  SESSION_IDLE_REAPER_TICK_MS: blankTolerantNonNegativeInt(3_600_000),
  // Close agents unused for this long. Default 3 days. 0 disables.
  SESSION_IDLE_REAPER_MAX_IDLE_MS: blankTolerantNonNegativeInt(259_200_000),
  // Loop workers are automation infrastructure, not user chat context. Keep the
  // ordinary project-agent threshold conservative, but reclaim idle workers much
  // sooner so scheduled automation cannot accumulate dozens of tmux sessions.
  SESSION_IDLE_REAPER_LOOP_WORKER_MAX_IDLE_MS: blankTolerantNonNegativeInt(21_600_000),
  // Automatically run reboot recovery on boot (no /recover needed). Idempotent —
  // a no-op when tmux survived a mere bot restart (everything's already alive),
  // does real work only after a machine reboot. Set to false/0 to disable.
  AUTO_RECOVER: z.string().default("true"),
  // macOS: keep the Mac awake on AC power while the bot runs so a plugged-in
  // laptop stays reachable from the phone. Opt-in; set by the setup wizard.
  TCB_KEEP_AWAKE: z.string().default("0"),
  LARK_ENABLED: z.string().default("false"),
  LARK_APP_ID: z.string().default(""),
  LARK_APP_SECRET: z.string().default(""),
  LARK_ALLOWED_OPEN_IDS: z.string().default(""),
  // `.catch` (not just `.default`) so a blank/invalid LARK_DOMAIN=... line falls
  // back instead of throwing at startup — a stray Lark line must not take down a
  // Telegram-only install.
  LARK_DOMAIN: z.enum(["feishu", "lark"]).catch("feishu"),
  // --- Optional local prompt translation ---
  PROMPT_TRANSLATE_MODE: z.string().default("off"),
  PROMPT_TRANSLATE_FROM: blankTolerantString("zh"),
  PROMPT_TRANSLATE_TO: blankTolerantString("en"),
  PROMPT_TRANSLATE_TIMEOUT_MS: blankTolerantPositiveInt(15000),
  TELEGRAM_PROMPT_TRANSLATE_MODE: z.string().default(""),
  TELEGRAM_PROMPT_TRANSLATE_FROM: z.string().default(""),
  TELEGRAM_PROMPT_TRANSLATE_TO: z.string().default(""),
  LARK_PROMPT_TRANSLATE_MODE: z.string().default(""),
  LARK_PROMPT_TRANSLATE_FROM: z.string().default(""),
  LARK_PROMPT_TRANSLATE_TO: z.string().default(""),
  CONTROL_PROMPT_TRANSLATE_MODE: z.string().default(""),
  CONTROL_PROMPT_TRANSLATE_FROM: z.string().default(""),
  CONTROL_PROMPT_TRANSLATE_TO: z.string().default(""),
  // Legacy aliases kept so existing voice-translation setups continue to boot.
  VOICE_TRANSLATE_MODE: z.string().default("off"),
  VOICE_TRANSLATE_FROM: blankTolerantString("zh"),
  VOICE_TRANSLATE_TO: blankTolerantString("en"),
  VOICE_TRANSLATE_TIMEOUT_MS: blankTolerantPositiveInt(15000),
  TELEGRAM_VOICE_TRANSLATE_MODE: z.string().default(""),
  TELEGRAM_VOICE_TRANSLATE_FROM: z.string().default(""),
  TELEGRAM_VOICE_TRANSLATE_TO: z.string().default(""),
  LARK_VOICE_TRANSLATE_MODE: z.string().default(""),
  LARK_VOICE_TRANSLATE_FROM: z.string().default(""),
  LARK_VOICE_TRANSLATE_TO: z.string().default(""),
  ARGOS_TRANSLATE_PYTHON: z.string().default(""),
  // --- Batch scheduler. BATCH_SCHEDULER_TICK_MS=0 disables the loop. ---
  BATCH_SCHEDULER_TICK_MS: optionalRawEnv,
  BATCH_SCHEDULER_QUOTA_PCT: optionalRawEnv,
  BATCH_SCHEDULER_REPROBE_MS: optionalRawEnv,
  // --- Resource guardian. Observes host pressure and optionally protects
  // background admission. Existing installations remain disabled by default. ---
  RESOURCE_GUARDIAN_ENABLED: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["true", "false"]).default("false"),
  ),
  RESOURCE_GUARDIAN_MODE: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["observe", "protect"]).default("observe"),
  ),
  RESOURCE_GUARDIAN_PROFILE: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["balanced", "conservative"]).default("balanced"),
  ),
  RESOURCE_GUARDIAN_TICK_MS: blankTolerantNonNegativeInt(15_000),
  // --- Runtime guardian. Watches bot-owned automation artifacts while the bot
  // is running and can delegate narrow self-repair for confirmed system issues. ---
  RUNTIME_GUARDIAN_ENABLED: blankTolerantString("false"),
  RUNTIME_GUARDIAN_MODE: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["observe", "fast-heal"]).default("fast-heal"),
  ),
  RUNTIME_GUARDIAN_WORKTREE_ISOLATION: worktreeIsolationSchema("auto"),
  RUNTIME_GUARDIAN_TICK_MS: blankTolerantNonNegativeInt(120000),
  RUNTIME_GUARDIAN_LOOKBACK_MS: blankTolerantNonNegativeInt(86_400_000),
  RUNTIME_GUARDIAN_COOLDOWN_MS: blankTolerantNonNegativeInt(1_800_000),
  RUNTIME_GUARDIAN_REPO_PATH: z.string().default(""),
  RUNTIME_GUARDIAN_REPAIR_BRANCH: blankTolerantString("dev"),
  RUNTIME_GUARDIAN_MAX_FINDINGS_PER_TICK: blankTolerantPositiveInt(3),
  // --- Daily scheduled task audit. TASK_AUDIT_TICK_MS=0 disables the loop. ---
  TASK_AUDIT_ENABLED: blankTolerantString("false"),
  TASK_AUDIT_SCHEDULE: blankTolerantString("0 2 * * *"),
  TASK_AUDIT_TICK_MS: blankTolerantNonNegativeInt(300000),
  TASK_AUDIT_CHANNEL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["telegram", "lark", "both"]).default("both"),
  ),
  TASK_AUDIT_AUTO_REPAIR: blankTolerantString("false"),
  TASK_AUDIT_REPO_PATH: z.string().default(""),
  TASK_AUDIT_REPAIR_BRANCH: blankTolerantString("dev"),
  TASK_AUDIT_REPAIR_WORKTREE_ISOLATION: worktreeIsolationSchema("isolated"),
  // --- Loop Engineering. Blank config file or tick 0 disables the managed loop. ---
  LOOP_ENGINEERING_CONFIG_FILE: z.string().default(""),
  LOOP_ENGINEERING_TICK_MS: blankTolerantNonNegativeInt(300000),
  LOOP_SUPERVISOR_ENABLED: blankTolerantString("false"),
  LOOP_SUPERVISOR_DIR: z.string().default(""),
  LOOP_SUPERVISOR_AGENT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["claude", "codex"]).default("codex"),
  ),
  LOOP_SUPERVISOR_POOL_SIZE: blankTolerantPositiveInt(1),
  LOOP_SUPERVISOR_RESET_BEFORE_WORK_ORDER: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["none", "compact", "clear"]).default("clear"),
  ),
  LOOP_SUPERVISOR_WORKTREE_ISOLATION: worktreeIsolationSchema("isolated"),
  // --- Home operator session ---
  HOME_OPERATOR_ENABLED: blankTolerantString("false"),
  HOME_OPERATOR_DIR: z.string().default(""),
  HOME_OPERATOR_AGENT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["claude", "codex"]).default("claude"),
  ),
  // --- Prompt library (optional; browse saved prompts via /prompts) ---
  PROMPT_MCP_COMMAND: z.string().default(""),
  PROMPT_MCP_ARGS: z.string().default(""),
  PROMPT_MCP_CWD: z.string().default(""),
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

/** Pin a fresh conversation id at launch via claude's `--session-id <uuid>` flag,
 * so the bot owns the exact id deterministically (codex can't pre-assign). Kept
 * with the other claude-command helpers so the CLI flag syntax stays out of the
 * orchestration layer. */
export function claudeStartCommandWithSessionId(command: string, sessionId: string): string {
  return `${command} --session-id ${sessionId}`;
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
 * Codex flavors (`CODEX_START_COMMAND[_N]`) are scanned the same way and
 * appended after the claude entries; every entry is tagged with its `agent`.
 */
export function parseStartCommands(env: NodeJS.ProcessEnv, primary: string): StartCommand[] {
  const out: StartCommand[] = [];
  const add = (
    command: string | undefined,
    labelKey: string,
    idx: number,
    agent: AgentKind,
  ): void => {
    const cmd = command?.trim();
    if (!cmd) return;
    out.push({ label: env[labelKey]?.trim() || deriveStartLabel(cmd, idx), command: cmd, agent });
  };
  add(primary, "CLAUDE_START_LABEL", 1, "claude");
  for (let i = 2; ; i++) {
    const cmd = env[`CLAUDE_START_COMMAND_${i}`];
    if (cmd === undefined) break; // stop at the first gap
    add(cmd, `CLAUDE_START_LABEL_${i}`, i, "claude");
  }
  // Codex flavors, appended after claude (mirrors the CLAUDE_START_COMMAND_* scan).
  add(env.CODEX_START_COMMAND, "CODEX_START_LABEL", 1, "codex");
  for (let i = 2; ; i++) {
    const cmd = env[`CODEX_START_COMMAND_${i}`];
    if (cmd === undefined) break; // stop at the first gap
    add(cmd, `CODEX_START_LABEL_${i}`, i, "codex");
  }
  return out;
}

/**
 * Load `.env` into process.env. Honors `TCB_ENV_FILE` so `npm run dev` can borrow
 * the deployed (prod) config — develop against the real token/proxy/Feishu with
 * hot reload, with no second `.env` to drift. Otherwise `.env` lives in the state
 * dir (alongside the other state files, written there by `env-store`/the setup
 * wizard) — NOT cwd, so a `tcb` command run from any directory still finds it.
 *
 * Transition: installs predating the `state/` subdir split keep `.env` at the
 * app-home root; if the state-dir `.env` is absent we also layer the legacy root
 * `.env` (dotenv never overrides an already-set key, so the state-dir copy wins).
 */
function loadEnvFile(): void {
  // `quiet: true` suppresses the dotenvx startup banner — it's noise in the
  // launchd logs and, critically, corrupts the stdout of data CLI commands like
  // `tcb dashboard --json` / `tcb logs --json` (it would break `| jq`).
  const explicit = process.env.TCB_ENV_FILE;
  if (explicit) {
    // An explicitly selected environment file is the operator's source of
    // truth. Override inherited launch-shell values so dev and service starts
    // cannot silently use a stale supervisor pool size or schedule.
    loadEnv({ path: explicit, quiet: true, override: true });
    return;
  }
  loadEnv({ path: appStateFile(".env"), quiet: true });
  if (!existsSync(appStateFile(".env"))) {
    loadEnv({ path: join(dirname(appStateDir()), ".env"), quiet: true });
  }
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
    telegramLongpollTimeoutSec: parsed.TELEGRAM_LONGPOLL_TIMEOUT_SEC,
    runningSweepMs: parsed.RUNNING_SWEEP_MS,
    sessionIdleReaper: {
      tickMs: parsed.SESSION_IDLE_REAPER_TICK_MS,
      maxIdleMs: parsed.SESSION_IDLE_REAPER_MAX_IDLE_MS,
      loopWorkerMaxIdleMs: parsed.SESSION_IDLE_REAPER_LOOP_WORKER_MAX_IDLE_MS,
    },
    autoRecover: parsed.AUTO_RECOVER !== "false" && parsed.AUTO_RECOVER !== "0",
    keepAwake: parsed.TCB_KEEP_AWAKE === "1" || parsed.TCB_KEEP_AWAKE === "true",
    lark,
    scheduler: {
      tickMs: blankTolerantNonNegativeInt(8000).parse(parsed.BATCH_SCHEDULER_TICK_MS),
      quotaPct: blankTolerantPositiveInt(99).parse(parsed.BATCH_SCHEDULER_QUOTA_PCT),
      reprobeMs: blankTolerantPositiveInt(1_800_000).parse(parsed.BATCH_SCHEDULER_REPROBE_MS),
    },
    resourceGuardian: {
      enabled: parsed.RESOURCE_GUARDIAN_ENABLED === "true",
      mode: parsed.RESOURCE_GUARDIAN_MODE,
      profile: parsed.RESOURCE_GUARDIAN_PROFILE,
      tickMs: parsed.RESOURCE_GUARDIAN_TICK_MS,
    },
    runtimeGuardian: {
      enabled:
        parsed.RUNTIME_GUARDIAN_ENABLED !== "false" && parsed.RUNTIME_GUARDIAN_ENABLED !== "0",
      mode: parsed.RUNTIME_GUARDIAN_MODE,
      worktreeIsolation: parsed.RUNTIME_GUARDIAN_WORKTREE_ISOLATION,
      tickMs: parsed.RUNTIME_GUARDIAN_TICK_MS,
      lookbackMs: parsed.RUNTIME_GUARDIAN_LOOKBACK_MS,
      cooldownMs: parsed.RUNTIME_GUARDIAN_COOLDOWN_MS,
      repoPath: parsed.RUNTIME_GUARDIAN_REPO_PATH.trim(),
      repairBranch: parsed.RUNTIME_GUARDIAN_REPAIR_BRANCH,
      maxFindingsPerTick: parsed.RUNTIME_GUARDIAN_MAX_FINDINGS_PER_TICK,
    },
    taskAudit: {
      enabled: parsed.TASK_AUDIT_ENABLED !== "false" && parsed.TASK_AUDIT_ENABLED !== "0",
      schedule: parsed.TASK_AUDIT_SCHEDULE,
      tickMs: parsed.TASK_AUDIT_TICK_MS,
      channel: parsed.TASK_AUDIT_CHANNEL,
      autoRepair:
        parsed.TASK_AUDIT_AUTO_REPAIR !== "false" && parsed.TASK_AUDIT_AUTO_REPAIR !== "0",
      repoPath: parsed.TASK_AUDIT_REPO_PATH.trim(),
      repairBranch: parsed.TASK_AUDIT_REPAIR_BRANCH,
      repairWorktreeIsolation: parsed.TASK_AUDIT_REPAIR_WORKTREE_ISOLATION,
    },
    loopEngineering: {
      configFile: parsed.LOOP_ENGINEERING_CONFIG_FILE.trim(),
      tickMs: parsed.LOOP_ENGINEERING_TICK_MS,
      supervisor: {
        enabled:
          parsed.LOOP_SUPERVISOR_ENABLED !== "false" && parsed.LOOP_SUPERVISOR_ENABLED !== "0",
        dir: parsed.LOOP_SUPERVISOR_DIR,
        agent: parsed.LOOP_SUPERVISOR_AGENT,
        poolSize: parsed.LOOP_SUPERVISOR_POOL_SIZE,
        resetBeforeWorkOrder: parsed.LOOP_SUPERVISOR_RESET_BEFORE_WORK_ORDER,
        worktreeIsolation: parsed.LOOP_SUPERVISOR_WORKTREE_ISOLATION,
      },
    },
    homeOperator: {
      enabled: parsed.HOME_OPERATOR_ENABLED !== "false" && parsed.HOME_OPERATOR_ENABLED !== "0",
      dir: parsed.HOME_OPERATOR_DIR,
      agent: parsed.HOME_OPERATOR_AGENT,
    },
    promptMcp: {
      command: parsed.PROMPT_MCP_COMMAND.trim(),
      args: parsed.PROMPT_MCP_ARGS.split(/\s+/).filter(Boolean),
      ...(parsed.PROMPT_MCP_CWD ? { cwd: parsed.PROMPT_MCP_CWD } : {}),
    },
  };
}

const scriptEnvSchema = z.object({
  CLAUDE_START_COMMAND: blankTolerantString("claude-yolo"),
  SESSION_WARMUP_MS: blankTolerantPositiveInt(500),
  PROJECT_SESSION_PREFIX: blankTolerantString("tmux_proj_"),
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
