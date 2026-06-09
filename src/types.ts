import type { ClaudeRunner } from "./services/claude.js";
import type { ConfigResolver } from "./services/claude-config-resolver.js";
import type { CurrentProjectManager } from "./services/currentProject.js";
import type { OutputProcessor } from "./services/output.js";
import type { MessageQueue } from "./services/queue.js";
import type { TmuxBridge } from "./services/tmux.js";

export type AppConfig = {
  botToken: string;
  claudeStartCommand: string;
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
  allowedUserIds: Set<string>;
  cdAllowedDirs: string[];
  projectSessionPrefix: string;
  httpProxy?: string | undefined;
};

export type BotCommand = { command: string; description: string };

export type ScriptConfig = {
  claudeStartCommand: string;
  sessionWarmupMs: number;
  projectSessionPrefix: string;
};

export type HandlerDeps = {
  bridge: TmuxBridge;
  queue: MessageQueue;
  claude: ClaudeRunner;
  output: OutputProcessor;
  config: AppConfig;
  currentProject: CurrentProjectManager;
  configResolver: ConfigResolver;
};
