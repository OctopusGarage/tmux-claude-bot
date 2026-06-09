import { normalizeError } from "../shared/utils/error.js";
import { logger } from "../shared/utils/logger.js";
import type { HandlerDeps } from "./deps.js";
import { getLatestAssistantReply } from "./history.js";
import type { QueuedMessage } from "./queue.js";
import { getPathBySession } from "./sessionPathMap.js";

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
  "status",
] as const;

export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

export function isMessageAction(action: string): action is MessageAction {
  return (MESSAGE_ACTIONS as readonly string[]).includes(action);
}

export async function executeMessage(msg: QueuedMessage, deps: HandlerDeps): Promise<string> {
  const session = msg.sessionName;
  if (!session) return "完成";
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
        throw new Error("Claude 未运行，请使用 /restart 启动");
      }
      logger.info(`[executor] sending keys session=${session}`);
      await deps.bridge.sendKeys(msg.text, session);
      logger.info(`[executor] keys sent, waiting for done session=${session}`);

      let rawResult: string;
      try {
        rawResult = await deps.claude.waitUntilDone(session);
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
          return `${historyReply.slice(0, maxLen)}\n\n...(内容过长，已截断)`;
        }
        return historyReply;
      }

      logger.info(
        `[executor] no history reply, using pane output session=${session} raw_len=${rawResult.length}`,
      );
      const processed = deps.output.process(rawResult);
      logger.info(`[executor] processed output len=${processed.length}`);
      if (!processed.trim()) {
        return "Claude 返回空内容 · 用 /peek 查看画面";
      }
      return processed;
    }
    case "start": {
      logger.info(`[executor] starting claude session=${session}`);
      await deps.claude.start(session);
      deps.configResolver.invalidate(session); // new process → re-detect config dir
      return "✅ Claude 已启动";
    }
    case "exit": {
      logger.info(`[executor] exiting claude session=${session}`);
      deps.queue.clearSession(session);
      await deps.bridge.sendExit(session);
      deps.configResolver.invalidate(session);
      return "✅ 已退出 Claude";
    }
    case "restart": {
      logger.info(`[executor] restarting claude session=${session}`);
      await deps.claude.gracefulRestartWithContinue(session);
      deps.configResolver.invalidate(session);
      return "🔄 Claude 已重启 · --continue";
    }
    case "esc": {
      logger.info(`[executor] sending esc session=${session}`);
      await deps.claude.interrupt(session);
      return "✅ 已发送 Esc";
    }
    case "interrupt": {
      logger.info(`[executor] sending ctrl-c session=${session}`);
      await deps.bridge.sendRawKey("C-c", session);
      return "✅ 已中断 · Ctrl-C";
    }
    case "clear": {
      logger.info(`[executor] sending /clear session=${session}`);
      await deps.bridge.sendKeys("/clear", session);
      return "✅ 已清空上下文 · /clear";
    }
    case "compact": {
      logger.info(`[executor] sending /compact session=${session}`);
      await deps.bridge.sendKeys("/compact", session);
      return "✅ 已压缩上下文 · /compact";
    }
    case "enter": {
      logger.info(`[executor] sending enter session=${session}`);
      await deps.bridge.sendRawKey("C-m", session);
      return "✅ 已回车";
    }
    case "up": {
      logger.info(`[executor] sending up session=${session}`);
      await deps.bridge.sendRawKey("Up", session);
      return "✅ 已发送 ↑";
    }
    case "down": {
      logger.info(`[executor] sending down session=${session}`);
      await deps.bridge.sendRawKey("Down", session);
      return "✅ 已发送 ↓";
    }
    case "status": {
      logger.info(`[executor] checking status session=${session}`);
      const running = await deps.claude.checkIfRunning(session);
      return running ? "🟢 Claude 运行中" : "🔴 Claude 未运行";
    }
    default: {
      const _exhaustive: never = msg.action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}
