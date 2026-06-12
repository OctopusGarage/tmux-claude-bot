export type LarkConfig = {
  appId: string;
  appSecret: string;
  allowedOpenIds: Set<string>;
  domain: "feishu" | "lark";
};

/** A selectable Claude start command: a full shell command line (may carry
 * leading `VAR=value` env assignments) plus a short button label. */
export type StartCommand = {
  label: string;
  command: string;
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
  lark?: LarkConfig | undefined;
};

export type BotCommand = { command: string; description: string };

export type ScriptConfig = {
  claudeStartCommand: string;
  sessionWarmupMs: number;
  projectSessionPrefix: string;
};
