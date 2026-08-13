import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConfigResolver, createExecProbe } from "./core/agents/agent-config-resolver.js";
import { parseClaudeFlavorAliases } from "./core/agents/claude/claude-flavor-alias.js";
import { DEFAULT_CONFIG_ROOT } from "./core/agents/claude/claude-history.js";
import { ClaudeRunner } from "./core/agents/claude/claude-runner.js";
import { parseCodexFlavorAliases } from "./core/agents/codex/codex-flavor-alias.js";
import { CodexRunner } from "./core/agents/codex/codex-runner.js";
import { AgentRunnerDispatcher } from "./core/agents/runner-dispatcher.js";
import { NotifierRegistry } from "./core/autopilot/notifier.js";
import { agentIsIdle } from "./core/command/agent-ready.js";
import { executeMessage } from "./core/command/dispatch.js";
import { MessageQueue } from "./core/command/queue.js";
import { defaultQueueObserver } from "./core/command/queue-observer.js";
import type { HandlerDeps } from "./core/deps.js";
import { disableStateRepositoryHooks } from "./core/infra/state-git-guard.js";
import { migrateLegacyStateDir } from "./core/infra/state-migration.js";
import { NotificationGateway } from "./core/notifications/gateway.js";
import { OwnerActivityTracker } from "./core/notifications/owner-activity.js";
import { ChannelSenderRegistry } from "./core/projects/channel-sender.js";
import { createProjectManager } from "./core/projects/project-manager.js";
import { createActivityWatcher } from "./core/session/activity-watcher.js";
import { OutputProcessor } from "./core/session/output.js";
import { TmuxBridge } from "./core/session/tmux.js";
import { claudeBinFromStartCommand, loadConfig } from "./shared/config.js";
import { SHELL_RC_FILES } from "./shared/shell-rc.js";
import { appStateDir } from "./shared/state-dir.js";
import { normalizeError } from "./shared/utils/error.js";

/** Concatenated shell rc files, mined for `claude-*`/`codex-*` launcher aliases.
 * The sync analogue of TakeoverProbe.readShellRc — bootstrap is synchronous, so
 * we read the same rc files directly, missing-tolerant. */
function readShellRcSync(home: string): string {
  return SHELL_RC_FILES.map((f) => {
    try {
      return readFileSync(join(home, f), "utf8");
    } catch {
      return "";
    }
  }).join("\n");
}

/** Derive the fs.watch roots: the `projects` dir of every claude config dir and
 * the `sessions` dir of every codex home — flavor aliases plus each agent's
 * default. De-duped. */
function deriveWatchRoots(home: string): string[] {
  const rc = readShellRcSync(home);
  const roots = new Set<string>();

  const claudeDirs = new Set<string>([DEFAULT_CONFIG_ROOT]);
  for (const a of parseClaudeFlavorAliases(rc, home)) {
    if (a.configDir) claudeDirs.add(a.configDir);
  }
  for (const dir of claudeDirs) roots.add(join(dir, "projects"));

  const codexHomes = new Set<string>([join(home, ".codex")]);
  for (const a of parseCodexFlavorAliases(rc, home)) {
    if (a.configDir) codexHomes.add(a.configDir);
  }
  for (const dir of codexHomes) roots.add(join(dir, "sessions"));

  return [...roots];
}

/**
 * Build the protocol-agnostic core service bundle ONCE and wire the shared
 * queue handler. Every adapter (Telegram, Lark, …) receives this same `deps`
 * and only supplies its own ingestion + per-message reply closures.
 */
export function bootstrap(): HandlerDeps {
  // Relocate any legacy root-level state into the state/ subdir BEFORE loadConfig
  // reads .env from it — closes the deploy-wipe that erased group_bindings.json.
  migrateLegacyStateDir();
  disableStateRepositoryHooks(appStateDir());
  const config = loadConfig();
  const { currentProject } = createProjectManager(appStateDir());

  const bridge = new TmuxBridge({
    getSessionName: () => currentProject.getAny().then((s) => s ?? "claude_bot"),
    projectSessionPrefix: config.projectSessionPrefix,
  });
  const output = new OutputProcessor({
    maxOutputLines: config.maxOutputLines,
    maxMessageLength: config.maxMessageLength,
  });
  const queue = new MessageQueue(
    config.maxQueueSize,
    undefined,
    config.maxConcurrentSessions,
    defaultQueueObserver,
  );
  const configResolver = createConfigResolver(createExecProbe(), {
    defaultRoot: DEFAULT_CONFIG_ROOT,
    claudeBin: claudeBinFromStartCommand(config.claudeStartCommand),
    ttlMs: 60_000,
  });

  const claudeRunner = new ClaudeRunner({
    bridge,
    output,
    configResolver,
    claudeCommand: config.claudeStartCommand,
    idlePollTicks: config.idlePollTicks,
    pollIntervalMs: config.pollIntervalMs,
    maxWaitReadyMs: config.maxWaitReadyMs,
    maxWaitDoneMs: config.maxWaitDoneMs,
  });

  const codexCommand = config.startCommands.find((c) => c.agent === "codex")?.command ?? "codex";
  const codexRunner = new CodexRunner({
    bridge,
    output,
    configResolver,
    codexCommand,
    idlePollTicks: config.idlePollTicks,
    pollIntervalMs: config.pollIntervalMs,
    maxWaitReadyMs: config.maxWaitReadyMs,
    maxWaitDoneMs: config.maxWaitDoneMs,
  });

  const agentRunner = new AgentRunnerDispatcher({
    bridge,
    claude: claudeRunner,
    codex: codexRunner,
    configResolver,
  });

  const activity = createActivityWatcher(deriveWatchRoots(homedir()));
  activity.start();

  const notifier = new NotifierRegistry();
  const notifications = new NotificationGateway();
  const ownerActivity = new OwnerActivityTracker();

  const deps: HandlerDeps = {
    bridge,
    queue,
    agent: agentRunner,
    output,
    config,
    currentProject,
    configResolver,
    activity,
    notifier,
    notifications,
    ownerActivity,
    channelSenders: new ChannelSenderRegistry(),
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

  // Idle-gate: hold a message in the queue while its session's agent is busy with
  // work the bot didn't start (the user driving it on the desktop), instead of
  // typing into a mid-render pane. The bot's own work is already serialized.
  queue.setReadinessProbe((session) => agentIsIdle(deps, session));

  return deps;
}
