import type { AppConfig } from "../shared/types.js";
import type { ConfigResolver } from "./agents/agent-config-resolver.js";
import type { AgentRunner } from "./agents/runner.js";
import type { NotifierRegistry } from "./autopilot/notifier.js";
import type { MessageQueue } from "./command/queue.js";
import type { CurrentProjectManager } from "./projects/project-manager.js";
import type { ActivityWatcher } from "./session/activity-watcher.js";
import type { OutputProcessor } from "./session/output.js";
import type { TmuxBridge } from "./session/tmux.js";

/**
 * The protocol-agnostic capability bundle the command dispatcher needs. Any
 * adapter (Telegram, Lark, …) constructs these core services and hands them
 * to `executeMessage`. Carries no platform/UI concepts.
 */
export type HandlerDeps = {
  bridge: TmuxBridge;
  queue: MessageQueue;
  /** The agent run loop — an AgentRunnerDispatcher that routes each call to the
   * claude or codex backend by the session's persisted agent kind. */
  agent: AgentRunner;
  output: OutputProcessor;
  config: AppConfig;
  currentProject: CurrentProjectManager;
  configResolver: ConfigResolver;
  /** Event-driven "is this transcript being written" signal, sourced from
   * fs.watch over the agents' transcript roots. */
  activity: ActivityWatcher;
  /** Proactive owner-notification fan-out; adapters register their push fn. */
  notifier: NotifierRegistry;
};
