export type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitter: boolean;
};

export type AutopilotRuntimeConfig = {
  tickMs: number; // fallback loop interval; 0 = master off
  idleGraceMs: number; // min idle before an idle-nudge
  cooldownMs: number; // min gap between nudges
  maxIterations: number; // nudges+recoveries per run before stop
  maxWallClockMs: number; // per-run wall-clock budget
  idlePromptText: string; // idle/recover resume nudge, e.g. "请继续完成当前任务"
  apiErrorPromptText: string; // distinct, clearer retry prompt for API errors
  maxRecoveryAttempts: number;
  /** Retry policy for other-transient API errors (connection closed, terminated, etc.) */
  retry: RetryPolicy;
  /** Retry policy for server-busy/overload/rate-limit errors — slower, longer backoff. */
  retryBusy: RetryPolicy;
  goalsDir: string;
  usagePausePct: number;
  keepAliveDoneMarker: string; // sentinel a pure keep-alive task emits when fully done
  keepAliveDonePrompt: string; // instruction appended to the keep-alive nudge asking for the marker
  maxRounds: number; // upper bound on goal-cycle rounds (clamp at parse time)
};

export type LarkConfig = {
  appId: string;
  appSecret: string;
  allowedOpenIds: Set<string>;
  domain: "feishu" | "lark";
};

/** Which coding agent a start command launches. Absent => "claude" (back-compat). */
export type AgentKind = "claude" | "codex";

/** UI glyph for an agent: 🟠 claude / 🔘 codex, or 💤 when none is live (null).
 * Single source so the alive-list, keyboards, and Lark cards never drift. */
export function agentGlyph(kind: AgentKind | null): string {
  return kind === "codex" ? "🔘" : kind === "claude" ? "🟠" : "💤";
}

/** Endpoint/auth an agent is using, for the /status line. `baseUrl` null = the
 * agent's default endpoint; `mode` is "api" (key/token set) vs "subscription"
 * (OAuth login). NEVER carries the key — only its presence. Shared by both agents
 * (claude mines it from process env, codex from auth.json/config.toml). */
export interface AgentApiInfo {
  baseUrl: string | null;
  mode: "api" | "subscription";
}

/** A selectable Claude start command: a full shell command line (may carry
 * leading `VAR=value` env assignments) plus a short button label. */
export type StartCommand = {
  label: string;
  command: string;
  agent?: AgentKind;
};

export type AppConfig = {
  telegramBotToken: string;
  /** The primary/default start command (= CLAUDE_START_COMMAND); kept for
   * backward compat and process detection. Equals `startCommands[0].command`. */
  claudeStartCommand: string;
  /** All configured start commands (CLAUDE_START_COMMAND + CLAUDE_START_COMMAND_2..N).
   * When more than one, the start button shows a picker. */
  startCommands: StartCommand[];
  idlePollTicks: number;
  pollIntervalMs: number;
  maxOutputLines: number;
  maxMessageLength: number;
  maxInboundLength: number;
  rateLimitMs: number;
  sessionWarmupMs: number;
  maxQueueSize: number;
  maxWaitReadyMs: number;
  maxWaitDoneMs: number;
  maxWaitDoneTotalMs: number;
  maxConcurrentSessions: number;
  telegramAllowedUserIds: Set<string>;
  cdAllowedDirs: string[];
  projectSessionPrefix: string;
  telegramHttpProxy?: string | undefined;
  /** Long-poll timeout (seconds) for getUpdates; default 30. Lower it behind a
   * flaky proxy so each poll returns before the proxy drops the connection. */
  telegramLongpollTimeoutSec: number;
  /** How often (ms) to reconcile the reboot-recovery running-sessions roster
   * against live tmux; default 5 min, 0 disables. */
  runningSweepMs: number;
  /** Run reboot recovery automatically on boot (idempotent); default true. */
  autoRecover: boolean;
  /** macOS: keep the Mac awake (caffeinate) while the bot runs so a sleeping
   * laptop can't drop it off the phone. Opt-in; works for any launch path. */
  keepAwake: boolean;
  lark?: LarkConfig | undefined;
  autopilot: AutopilotRuntimeConfig;
  scheduler: { tickMs: number; quotaPct: number; reprobeMs: number };
  homeOperator: { enabled: boolean; dir: string; agent: "claude" | "codex" };
  promptMcp: { command: string; args: string[]; cwd?: string };
};

export type BotCommand = { command: string; description: string };

export type ScriptConfig = {
  claudeStartCommand: string;
  sessionWarmupMs: number;
  projectSessionPrefix: string;
};
