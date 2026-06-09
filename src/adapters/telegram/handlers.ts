import * as fs from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import type { Bot } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { executeMessage } from "../../core/dispatch.js";
import { appendRecentProject } from "../../core/recentProjects.js";
import {
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "../../core/sessionPathMap.js";
import { normalizeError } from "../../shared/utils/error.js";
import { logger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { handleCallbackQuery } from "./callbacks.js";
import { createRestoredMessage, handleQueuedCommand } from "./executor.js";
import { buildRecentKeyboard } from "./keyboards.js";
import { MSG } from "./messages.js";
import {
  addRecentProjectBySid,
  recentProjectButtons,
  removeProjectBySession,
  resolveAliveSessionByShortId,
  switchToProject,
} from "./project-ops.js";
import { runPromptWithProgress } from "./prompt-lifecycle.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { resolveSessionFromReply } from "./session.js";
import { sendAliveList, sendHistory, sendPeek, sendQueueStatus } from "./views.js";

const HELP_TEXT = `🤖 tmux-claude-telegram

发任意文字 → 转给 Claude → 返回结果
🎙️ 语音转写为可选功能 · /voice_install 启用（仅 Apple Silicon）· /voice_lang 设识别语言

提示：消息会收到 👀（已接收）/👍（完成）回应；处理中就地显示进度并编辑成结果；结果下方有 ⏎/✋/⎋/🔄 快捷按钮。

━━ 📂 项目 ━━
/current_project — 当前项目
/list_alive_projects — 活跃项目（点按切换/删除）
/list_recent_projects — 近期项目
/add_project <路径> — 新建项目
/queue_status — 队列状态
/history [N] — 对话历史（默认最近一条）

━━ ⚡ Claude 运行中 ━━
/enter — 回车    /esc — Escape
/interrupt — Ctrl-C    /restart — 重启 (--continue)
/clear — 清空上下文    /compact — 压缩上下文
/up · /down — 上下方向键    /exit — 退出

━━ 🚀 未运行 ━━
/start — 启动 Claude
/peek — 查看 tmux 画面
/status — 检查状态
/help — 本帮助`;

export function registerHandlers(bot: Bot, deps: HandlerDeps, replyTarget: ReplyTargetMap): void {
  deps.queue.setHandler(async (msg) => {
    try {
      const result = await executeMessage(msg, deps);
      msg.resolve(result);
    } catch (err) {
      msg.reject(normalizeError(err));
    }
  });

  const persisted = deps.queue.loadPersisted();
  if (persisted.length > 0) {
    deps.queue.clearPersisted();
    for (const p of persisted) {
      deps.queue.enqueue(createRestoredMessage(p, bot));
    }
  }

  bot.command("help", async (ctx) => {
    await reply(ctx, "help", HELP_TEXT);
  });

  bot.command("status", async (ctx) =>
    handleQueuedCommand(ctx, deps, "status", undefined, replyTarget),
  );
  bot.command("start", async (ctx) =>
    handleQueuedCommand(ctx, deps, "start", undefined, replyTarget),
  );
  bot.command("esc", async (ctx) => handleQueuedCommand(ctx, deps, "esc", undefined, replyTarget));
  bot.command("restart", async (ctx) =>
    handleQueuedCommand(ctx, deps, "restart", undefined, replyTarget),
  );
  bot.command("exit", async (ctx) =>
    handleQueuedCommand(ctx, deps, "exit", undefined, replyTarget),
  );
  bot.command("interrupt", async (ctx) =>
    handleQueuedCommand(ctx, deps, "interrupt", undefined, replyTarget),
  );
  bot.command("clear", async (ctx) =>
    handleQueuedCommand(ctx, deps, "clear", undefined, replyTarget),
  );
  bot.command("compact", async (ctx) =>
    handleQueuedCommand(ctx, deps, "compact", undefined, replyTarget),
  );
  bot.command("enter", async (ctx) =>
    handleQueuedCommand(ctx, deps, "enter", undefined, replyTarget),
  );
  bot.command("up", async (ctx) => handleQueuedCommand(ctx, deps, "up", undefined, replyTarget));
  bot.command("down", async (ctx) =>
    handleQueuedCommand(ctx, deps, "down", undefined, replyTarget),
  );

  bot.command("peek", async (ctx) => {
    const session = await resolveSessionFromReply(ctx, replyTarget, deps);
    if (!session) {
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    await sendPeek(ctx, deps, session, replyTarget);
  });

  // Project management commands (direct execution)
  bot.command("add_project", async (ctx) => {
    const args = (ctx.message?.text ?? "").split(" ").slice(1);
    if (args.length === 0) {
      await reply(ctx, "info", "用法：/add_project <路径>\n\n示例：/add_project ~/projects/myapp");
      return;
    }
    const rawPath = args.join(" ");
    const resolvedPath = nodePath.resolve(rawPath.replaceAll("~", homedir()));

    try {
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) {
        await reply(ctx, "err", `${resolvedPath} 不是目录`);
        return;
      }
    } catch {
      await reply(ctx, "err", `目录不存在：${resolvedPath}`);
      return;
    }

    if (!isCdAllowed(resolvedPath, deps.config.cdAllowedDirs)) {
      await reply(ctx, "err", MSG.pathNotAllowed(deps.config.cdAllowedDirs));
      return;
    }

    const sessionName = sessionNameFromPath(resolvedPath, deps.config.projectSessionPrefix);
    try {
      const exists = await deps.bridge.hasSession(sessionName);
      if (exists) {
        await deps.currentProject.set(sessionName);
        setPathForSession(sessionName, resolvedPath);
        await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
        await reply(ctx, "warn", "已存在 · 已切换", { session: sessionName, replyTarget });
        return;
      }
      await deps.bridge.createSession(sessionName);
      await deps.currentProject.set(sessionName);
      await sleep(deps.config.sessionWarmupMs);
      await deps.bridge.sendKeys(`cd "${resolvedPath}"`);
      await sleep(deps.config.sessionWarmupMs);
      setPathForSession(sessionName, resolvedPath);
      await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
      await reply(ctx, "ok", "项目已创建", {
        session: sessionName,
        body: resolvedPath,
        replyTarget,
      });
    } catch (err) {
      await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
    }
  });

  bot.command("current_project", async (ctx) => {
    const session = await deps.currentProject.get();
    if (!session) {
      await reply(ctx, "err", "未设置当前项目\n\n用 /add_project <路径> 设置一个");
      return;
    }
    const exists = await deps.bridge.hasSession(session);
    const pathPart = getPathBySession(session) ?? session;
    const status = exists ? "✅ 当前活跃" : "🔴 未找到";
    await reply(ctx, "list", "当前项目", { session, body: `${pathPart}\n${status}` });
  });

  bot.command("list_alive_projects", async (ctx) => {
    await sendAliveList(ctx, deps);
  });

  bot.command("list_recent_projects", async (ctx) => {
    const buttons = await recentProjectButtons(deps);
    if (buttons.length === 0) {
      await reply(ctx, "list", "没有近期项目\n\n用 /add_project <路径> 添加一个");
      return;
    }
    // No body — the buttons already show each project name + status (✅/🔀/➕).
    await reply(ctx, "list", `近期项目 (${buttons.length})`, {
      replyMarkup: buildRecentKeyboard(buttons),
    });
  });

  bot.command("queue_status", async (ctx) => {
    await sendQueueStatus(ctx, deps);
  });

  bot.command("history", async (ctx) => {
    const args = (ctx.message?.text ?? "").split(" ").slice(1);
    let index = 0; // 0 = most recent (default)
    const arg0 = args[0];
    if (arg0 !== undefined) {
      const parsed = parseInt(arg0, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        index = parsed - 1;
      }
    }

    const session = await resolveSessionFromReply(ctx, replyTarget, deps);
    if (!session) {
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    await sendHistory(ctx, deps, session, index, replyTarget);
  });

  // Inline-button taps: control panel (esc/interrupt/enter/restart) and the
  // project list's switch/remove buttons.
  bot.on("callback_query:data", (ctx) => handleCallbackQuery(ctx, deps, replyTarget));

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat?.id ?? "unknown";
    logger.info(`[handlers] message received chat=${chatId} text_len=${text.length}`);

    if (text.length > deps.config.maxInboundLength) {
      logger.warn(`[handlers] message too long chat=${chatId} len=${text.length}`);
      await reply(ctx, "err", `消息过长 · ${text.length} > ${deps.config.maxInboundLength} 字符`);
      return;
    }

    // Check if this message is a reply to one of our sent messages
    const replyToMsg = ctx.message.reply_to_message;
    let targetSession: string | null = null;
    if (replyToMsg) {
      targetSession = replyTarget.resolveReplyTarget(replyToMsg.message_id);
      if (targetSession) {
        logger.info(
          `[handlers] reply detected msgId=${replyToMsg.message_id} → session=${targetSession}`,
        );
      }
    }

    const switchMatch = text.match(/^\/switch_([a-zA-Z0-9]{6})$/);
    if (switchMatch) {
      const id = switchMatch[1] ?? "";
      try {
        const sessionName = await resolveAliveSessionByShortId(deps, id);
        if (!sessionName) {
          await reply(ctx, "err", MSG.noShortId(id), { replyTarget });
          return;
        }
        await switchToProject(deps, sessionName);
        await reply(ctx, "ok", "已切换", { session: sessionName, replyTarget });
      } catch (err) {
        await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
      }
      return;
    }

    const removeMatch = text.match(/^\/remove_([a-zA-Z0-9]{6})$/);
    if (removeMatch) {
      const id = removeMatch[1] ?? "";
      try {
        const sessionName = await resolveAliveSessionByShortId(deps, id);
        if (!sessionName) {
          await reply(ctx, "err", MSG.noShortId(id), { replyTarget });
          return;
        }
        await removeProjectBySession(deps, replyTarget, sessionName);
        await reply(ctx, "ok", "已移除", { session: sessionName, replyTarget });
      } catch (err) {
        await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
      }
      return;
    }

    const addProjectMatch = text.match(/^\/add_project_([a-zA-Z0-9]{6})$/);
    if (addProjectMatch) {
      await addRecentProjectBySid(deps, ctx, addProjectMatch[1] ?? "", replyTarget);
      return;
    }

    const currentSessionName = targetSession ?? (await deps.currentProject.get());
    if (!currentSessionName) {
      logger.warn(`[handlers] no current session chat=${chatId}`);
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    replyTarget.record(ctx.message.message_id, currentSessionName);
    logger.info(
      `[handlers] currentSession=${currentSessionName} chat=${chatId} via=${targetSession ? "reply" : "currentProject"}`,
    );
    const isRunning = await deps.claude.checkIfRunning(currentSessionName);
    if (isRunning) {
      logger.info(`[handlers] enqueuing text message session=${currentSessionName} chat=${chatId}`);
      await runPromptWithProgress(ctx, deps, currentSessionName, text, replyTarget);
      return;
    }

    logger.warn(`[handlers] claude not running session=${currentSessionName} chat=${chatId}`);
    await reply(ctx, "err", MSG.notRunning);
  });
}
