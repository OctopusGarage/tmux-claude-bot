import { accessSync, constants } from "node:fs";
import * as nodePath from "node:path";
import { claudeBinFromStartCommand } from "../../shared/config.js";
import type { AgentKind } from "../../shared/types.js";
import { normalizeError } from "../../shared/utils/error.js";
import { logger } from "../../shared/utils/logger.js";
import { resolveAgentKind, setAgentKind } from "../agents/agentKindMap.js";
import { profileFor } from "../agents/registry.js";
import type { HandlerDeps } from "../deps.js";
import { messages } from "../i18n/index.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import type { QueuedMessage } from "./queue.js";

/** Derive the AgentKind for a start command by matching against startCommands config. */
function agentKindForCommand(deps: HandlerDeps, command: string | undefined): AgentKind {
  if (command === undefined) return "claude";
  return deps.config.startCommands.find((c) => c.command === command)?.agent ?? "claude";
}

export function assertClaudeBinaryAccessible(claudeStartCommand: string): void {
  const bin = claudeBinFromStartCommand(claudeStartCommand);
  if (nodePath.isAbsolute(bin)) {
    try {
      accessSync(bin, constants.X_OK);
      return;
    } catch {
      throw new Error(`Claude binary not found or not executable: ${bin}`);
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(nodePath.join(dir, bin), constants.X_OK);
      return;
    } catch {
      // continue searching
    }
  }
  throw new Error(`Claude binary "${bin}" not found in PATH`);
}

/**
 * Start Claude in `session`, optionally with a specific start command (from the
 * multi-command picker). Shared by the default `start` action and the adapters'
 * pick-a-start handlers so the assert/start/invalidate sequence stays in one place.
 */
export async function performStart(
  deps: HandlerDeps,
  session: string,
  command?: string,
): Promise<void> {
  assertClaudeBinaryAccessible(command ?? deps.config.claudeStartCommand);
  setAgentKind(session, agentKindForCommand(deps, command));
  await deps.agent.start(session, command);
  deps.configResolver.invalidate(session); // new process → re-detect config dir
}

/** Restart Claude into `command`'s flavor (default: the primary), resuming the
 * conversation (`--continue`). Used by the restart-command picker. */
export async function performRestart(
  deps: HandlerDeps,
  session: string,
  command?: string,
): Promise<void> {
  assertClaudeBinaryAccessible(command ?? deps.config.claudeStartCommand);
  setAgentKind(session, agentKindForCommand(deps, command));
  await deps.agent.gracefulRestartWithContinue(session, command);
  deps.configResolver.invalidate(session); // new process → re-detect config dir
}

/**
 * The protocol-agnostic command layer. Given a queued message (an action + the
 * session it targets) and the core service bundle, perform the work against
 * tmux/Claude and return the plain-text result. Knows nothing about Telegram,
 * grammy, chats, or rendering — adapters wrap this and present the string.
 */

export const MESSAGE_ACTIONS = [
  "text",
  "start",
  "exit",
  "restart",
  "esc",
  "interrupt",
  "clear",
  "compact",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "tab",
  "status",
] as const;

export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

export function isMessageAction(action: string): action is MessageAction {
  return (MESSAGE_ACTIONS as readonly string[]).includes(action);
}

export async function executeMessage(msg: QueuedMessage, deps: HandlerDeps): Promise<string> {
  const m = messages(msg.channel ?? "telegram");
  const session = msg.sessionName;
  if (!session) return m.doneShort;
  if (!isMessageAction(msg.action)) {
    throw new Error(`Unknown action: ${msg.action}`);
  }

  logger.info(
    `[executor] action=${msg.action} session=${session} text_len=${msg.text?.length ?? 0}`,
  );

  switch (msg.action) {
    case "text": {
      const running = await deps.agent.checkIfRunning(session);
      if (!running) {
        logger.warn(`[executor] text action rejected: Claude not running session=${session}`);
        throw new Error(m.agentNotRunningRestart);
      }
      logger.info(`[executor] sending keys session=${session}`);
      await deps.bridge.sendKeys(msg.text, session);
      logger.info(`[executor] keys sent, waiting for done session=${session}`);

      // Wait in maxWaitDoneMs rounds up to maxWaitDoneTotalMs total. The first
      // expired round sends a one-time "still running" notice (when the adapter
      // provided a notify channel) and waiting continues — so long tasks resolve
      // with their real result instead of a partial snapshot, and nothing gets
      // typed into a still-busy pane. Past the horizon, give up with partials.
      let rawResult: string;
      try {
        let round = await deps.agent.waitUntilDone(session);
        let waitedMs = deps.config.maxWaitDoneMs;
        let noticed = false;
        while (!round.done && waitedMs < deps.config.maxWaitDoneTotalMs) {
          if (!noticed) {
            msg.notify?.(m.taskStillRunningNotice);
            noticed = true;
          }
          logger.info(
            `[executor] still running session=${session} waited=${waitedMs}ms, continuing to wait`,
          );
          round = await deps.agent.waitUntilDone(session);
          waitedMs += deps.config.maxWaitDoneMs;
        }
        if (!round.done) {
          logger.warn(`[executor] gave up waiting session=${session} after ${waitedMs}ms`);
          return m.taskStillRunning(deps.output.process(round.output));
        }
        rawResult = round.output;
      } catch (err) {
        logger.error(
          `[executor] waitUntilDone failed: ${err instanceof Error ? err.message : err}`,
        );
        try {
          const pane = await deps.bridge.capturePane(session);
          rawResult = deps.output.process(pane);
        } catch (paneErr) {
          logger.error(
            `[executor] capturePane fallback failed: ${paneErr instanceof Error ? paneErr.message : paneErr}`,
          );
          throw normalizeError(err);
        }
      }

      const projectPath = getPathBySession(session) ?? session;
      // Read the reply from the agent's transcript (cleaner than scraping the
      // ANSI pane). claude: <CLAUDE_CONFIG_DIR>/projects JSONL; codex: the rollout
      // under <CODEX_HOME>/sessions. Either may return null → pane fallback below.
      const profile = profileFor(await resolveAgentKind(deps.configResolver, session));
      logger.info(`[executor] looking up history session=${session} path=${projectPath}`);
      const historyReply = await profile.getLatestReply(
        deps.configResolver,
        session,
        projectPath,
        msg.text,
      );
      if (historyReply?.trim()) {
        logger.info(`[executor] history reply found len=${historyReply.length}`);
        const maxLen = deps.config.maxMessageLength - 100;
        if (historyReply.length > maxLen) {
          return `${historyReply.slice(0, maxLen)}\n\n${m.contentTruncated}`;
        }
        return historyReply;
      }

      logger.info(
        `[executor] no history reply, using pane output session=${session} raw_len=${rawResult.length}`,
      );
      const processed = deps.output.process(rawResult);
      logger.info(`[executor] processed output len=${processed.length}`);
      if (!processed.trim()) {
        return m.agentEmptyOutput;
      }
      return processed;
    }
    case "start": {
      logger.info(`[executor] starting agent session=${session}`);
      await performStart(deps, session);
      return m.agentStarted;
    }
    case "exit": {
      logger.info(`[executor] exiting agent session=${session}`);
      deps.queue.clearSession(session);
      // Route through the agent runner (both claude and codex: Ctrl-C + `/exit`),
      // not the hardcoded bridge.sendExit it used to call.
      await deps.agent.exit(session);
      deps.configResolver.invalidate(session);
      return m.agentExited;
    }
    case "restart": {
      logger.info(`[executor] restarting agent session=${session}`);
      await deps.agent.gracefulRestartWithContinue(session);
      deps.configResolver.invalidate(session);
      return m.agentRestarted;
    }
    case "esc": {
      logger.info(`[executor] sending esc session=${session}`);
      await deps.agent.interrupt(session);
      return m.sentEsc;
    }
    case "interrupt": {
      logger.info(`[executor] sending ctrl-c session=${session}`);
      await deps.bridge.sendRawKey("C-c", session);
      return m.interrupted;
    }
    case "clear": {
      logger.info(`[executor] sending /clear session=${session}`);
      await deps.bridge.sendKeys("/clear", session);
      // /clear starts a fresh session → a NEW transcript file; drop the cached
      // open-transcript so the next read/usage re-detects it (the resolver's
      // documented invalidation trigger).
      deps.configResolver.invalidate(session);
      return m.clearedContext;
    }
    case "compact": {
      logger.info(`[executor] sending /compact session=${session}`);
      await deps.bridge.sendKeys("/compact", session);
      deps.configResolver.invalidate(session);
      return m.compactedContext;
    }
    case "enter": {
      logger.info(`[executor] sending enter session=${session}`);
      await deps.bridge.sendRawKey("C-m", session);
      return m.sentEnter;
    }
    case "up": {
      logger.info(`[executor] sending up session=${session}`);
      await deps.bridge.sendRawKey("Up", session);
      return m.sentUp;
    }
    case "down": {
      logger.info(`[executor] sending down session=${session}`);
      await deps.bridge.sendRawKey("Down", session);
      return m.sentDown;
    }
    case "left": {
      logger.info(`[executor] sending left session=${session}`);
      await deps.bridge.sendRawKey("Left", session);
      return m.sentLeft;
    }
    case "right": {
      logger.info(`[executor] sending right session=${session}`);
      await deps.bridge.sendRawKey("Right", session);
      return m.sentRight;
    }
    case "tab": {
      logger.info(`[executor] sending tab session=${session}`);
      await deps.bridge.sendRawKey("Tab", session);
      return m.sentTab;
    }
    case "status": {
      logger.info(`[executor] checking status session=${session}`);
      const running = await deps.agent.checkIfRunning(session);
      const channel = msg.channel ?? "telegram";
      const profile = profileFor(await resolveAgentKind(deps.configResolver, session));
      return profile.buildStatusReport(deps, session, channel, running);
    }
    default: {
      const _exhaustive: never = msg.action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}
