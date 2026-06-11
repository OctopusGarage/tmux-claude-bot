import { accessSync, constants } from "node:fs";
import * as nodePath from "node:path";
import { claudeBinFromStartCommand } from "../shared/config.js";
import { normalizeError } from "../shared/utils/error.js";
import { logger } from "../shared/utils/logger.js";
import type { HandlerDeps } from "./deps.js";
import { getLatestAssistantReply } from "./history.js";
import { messages } from "./i18n/index.js";
import type { QueuedMessage } from "./queue.js";
import { getPathBySession } from "./sessionPathMap.js";

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
      const running = await deps.claude.checkIfRunning(session);
      if (!running) {
        logger.warn(`[executor] text action rejected: Claude not running session=${session}`);
        throw new Error(m.claudeNotRunningRestart);
      }
      logger.info(`[executor] sending keys session=${session}`);
      await deps.bridge.sendKeys(msg.text, session);
      logger.info(`[executor] keys sent, waiting for done session=${session}`);

      let rawResult: string;
      try {
        rawResult = await deps.claude.waitUntilDone(session, msg.channel ?? "telegram");
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
      const configRoot = await deps.configResolver.resolveConfigRoot(session);
      logger.info(
        `[executor] looking up history session=${session} path=${projectPath} root=${configRoot}`,
      );
      const historyReply = await getLatestAssistantReply(projectPath, msg.text, configRoot);
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
        return m.claudeEmptyOutput;
      }
      return processed;
    }
    case "start": {
      logger.info(`[executor] starting claude session=${session}`);
      assertClaudeBinaryAccessible(deps.config.claudeStartCommand);
      await deps.claude.start(session);
      deps.configResolver.invalidate(session); // new process → re-detect config dir
      return m.claudeStarted;
    }
    case "exit": {
      logger.info(`[executor] exiting claude session=${session}`);
      deps.queue.clearSession(session);
      await deps.bridge.sendExit(session);
      deps.configResolver.invalidate(session);
      return m.claudeExited;
    }
    case "restart": {
      logger.info(`[executor] restarting claude session=${session}`);
      await deps.claude.gracefulRestartWithContinue(session);
      deps.configResolver.invalidate(session);
      return m.claudeRestarted;
    }
    case "esc": {
      logger.info(`[executor] sending esc session=${session}`);
      await deps.claude.interrupt(session);
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
      return m.clearedContext;
    }
    case "compact": {
      logger.info(`[executor] sending /compact session=${session}`);
      await deps.bridge.sendKeys("/compact", session);
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
    case "tab": {
      logger.info(`[executor] sending tab session=${session}`);
      await deps.bridge.sendRawKey("Tab", session);
      return m.sentTab;
    }
    case "status": {
      logger.info(`[executor] checking status session=${session}`);
      const running = await deps.claude.checkIfRunning(session);
      return running ? m.statusRunning : m.statusNotRunning;
    }
    default: {
      const _exhaustive: never = msg.action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}
