import { ClaudeRunner } from "./core/claude.js";
import { createConfigResolver, createExecProbe } from "./core/claude-config-resolver.js";
import type { HandlerDeps } from "./core/deps.js";
import { executeMessage } from "./core/dispatch.js";
import { DEFAULT_CONFIG_ROOT } from "./core/history.js";
import { OutputProcessor } from "./core/output.js";
import { createProjectManager } from "./core/project-manager.js";
import { MessageQueue } from "./core/queue.js";
import { TmuxBridge } from "./core/tmux.js";
import { claudeBinFromStartCommand, loadConfig } from "./shared/config.js";
import { normalizeError } from "./shared/utils/error.js";

/**
 * Build the protocol-agnostic core service bundle ONCE and wire the shared
 * queue handler. Every adapter (Telegram, Lark, …) receives this same `deps`
 * and only supplies its own ingestion + per-message reply closures.
 */
export function bootstrap(): HandlerDeps {
  const config = loadConfig();
  const { currentProject } = createProjectManager(process.cwd());

  const bridge = new TmuxBridge({
    getSessionName: () => currentProject.getAny().then((s) => s ?? "claude_bot"),
    projectSessionPrefix: config.projectSessionPrefix,
  });
  const output = new OutputProcessor({
    maxOutputLines: config.maxOutputLines,
    maxMessageLength: config.maxMessageLength,
  });
  const queue = new MessageQueue(config.maxQueueSize);
  const configResolver = createConfigResolver(createExecProbe(), {
    defaultRoot: DEFAULT_CONFIG_ROOT,
    claudeBin: claudeBinFromStartCommand(config.claudeStartCommand),
    ttlMs: 60_000,
  });
  const claude = new ClaudeRunner({
    bridge,
    output,
    configResolver,
    claudeCommand: config.claudeStartCommand,
    idlePollTicks: config.idlePollTicks,
    pollIntervalMs: config.pollIntervalMs,
    maxWaitReadyMs: config.maxWaitReadyMs,
    maxWaitDoneMs: config.maxWaitDoneMs,
  });

  const deps: HandlerDeps = {
    bridge,
    queue,
    claude,
    output,
    config,
    currentProject,
    configResolver,
  };

  // The queue handler is protocol-agnostic: it runs the command and routes the
  // result back through the per-message resolve/reject closures the adapter set.
  queue.setHandler(async (msg) => {
    try {
      msg.resolve(await executeMessage(msg, deps));
    } catch (err) {
      msg.reject(normalizeError(err));
    }
  });

  return deps;
}
