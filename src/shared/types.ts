export type LarkConfig = {
  appId: string;
  appSecret: string;
  allowedOpenIds: Set<string>;
  domain: "feishu" | "lark";
};

export type AppConfig = {
  telegramBotToken: string;
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
