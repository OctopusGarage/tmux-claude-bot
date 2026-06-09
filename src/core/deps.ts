import type { AppConfig } from "../shared/types.js";
import type { ClaudeRunner } from "./claude.js";
import type { ConfigResolver } from "./claude-config-resolver.js";
import type { CurrentProjectManager } from "./currentProject.js";
import type { OutputProcessor } from "./output.js";
import type { MessageQueue } from "./queue.js";
import type { TmuxBridge } from "./tmux.js";

/**
 * The protocol-agnostic capability bundle the command dispatcher needs. Any
 * adapter (Telegram, Feishu, …) constructs these core services and hands them
 * to `executeMessage`. Carries no platform/UI concepts.
 */
export type HandlerDeps = {
  bridge: TmuxBridge;
  queue: MessageQueue;
  claude: ClaudeRunner;
  output: OutputProcessor;
  config: AppConfig;
  currentProject: CurrentProjectManager;
  configResolver: ConfigResolver;
};
