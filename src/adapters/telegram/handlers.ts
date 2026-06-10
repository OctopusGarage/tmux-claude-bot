import * as fs from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import type { Bot } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { isUiLang, messages, resolveUiLang, setUiLang, UI_LANGS } from "../../core/i18n/index.js";
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
import { buildLangKeyboard, buildRecentKeyboard } from "./keyboards.js";
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

export function registerHandlers(bot: Bot, deps: HandlerDeps, replyTarget: ReplyTargetMap): void {
  const persisted = deps.queue.loadPersisted();
  if (persisted.length > 0) {
    deps.queue.clearPersisted();
    for (const p of persisted) {
      if (p.channel === "lark") continue; // Lark restore is out of scope (Phase 1)
      deps.queue.enqueue(createRestoredMessage(p, bot));
    }
  }

  bot.command("lang", async (ctx) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.trim().toLowerCase();
    const labelOf = (l: string): string => UI_LANGS.find((x) => x.code === l)?.label ?? l;
    if (!arg) {
      const current = resolveUiLang("telegram");
      await reply(ctx, "info", messages("telegram").uiLangCurrent(labelOf(current)), {
        replyTarget,
        replyMarkup: buildLangKeyboard(current),
      });
      return;
    }
    if (!isUiLang(arg)) {
      await reply(ctx, "err", "用法 / Usage: /lang <en|zh|yue>", { replyTarget });
      return;
    }
    setUiLang("telegram", arg);
    await reply(ctx, "info", messages("telegram").uiLangSet(labelOf(arg)), { replyTarget });
  });

  bot.command("help", async (ctx) => {
    await reply(ctx, "help", messages("telegram").helpBodyTelegram);
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
      await reply(ctx, "info", messages("telegram").addProjectUsageExample);
      return;
    }
    const rawPath = args.join(" ");
    const resolvedPath = nodePath.resolve(rawPath.replaceAll("~", homedir()));

    try {
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) {
        await reply(ctx, "err", messages("telegram").notADir(resolvedPath));
        return;
      }
    } catch {
      await reply(ctx, "err", messages("telegram").dirNotExist(resolvedPath));
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
        await deps.currentProject.set("telegram", sessionName);
        setPathForSession(sessionName, resolvedPath);
        await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
        await reply(ctx, "warn", messages("telegram").alreadySwitched, {
          session: sessionName,
          replyTarget,
        });
        return;
      }
      await deps.bridge.createSession(sessionName);
      await deps.currentProject.set("telegram", sessionName);
      await sleep(deps.config.sessionWarmupMs);
      await deps.bridge.sendKeys(`cd "${resolvedPath}"`);
      await sleep(deps.config.sessionWarmupMs);
      setPathForSession(sessionName, resolvedPath);
      await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
      await reply(ctx, "ok", messages("telegram").projectCreated, {
        session: sessionName,
        body: resolvedPath,
        replyTarget,
      });
    } catch (err) {
      await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
    }
  });

  bot.command("current_project", async (ctx) => {
    const session = await deps.currentProject.get("telegram");
    if (!session) {
      await reply(ctx, "err", messages("telegram").noCurrentProjectSet);
      return;
    }
    const exists = await deps.bridge.hasSession(session);
    const pathPart = getPathBySession(session) ?? session;
    const status = exists
      ? messages("telegram").currentActive
      : messages("telegram").currentNotFound;
    await reply(ctx, "list", messages("telegram").currentProjectTitle, {
      session,
      body: `${pathPart}\n${status}`,
    });
  });

  bot.command("list_alive_projects", async (ctx) => {
    await sendAliveList(ctx, deps);
  });

  bot.command("list_recent_projects", async (ctx) => {
    const buttons = await recentProjectButtons(deps, "telegram");
    if (buttons.length === 0) {
      await reply(ctx, "list", messages("telegram").noRecentProjects);
      return;
    }
    // No body — the buttons already show each project name + status (✅/🔀/➕).
    await reply(ctx, "list", messages("telegram").recentListTitleN(buttons.length), {
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
      await reply(
        ctx,
        "err",
        messages("telegram").messageTooLong(text.length, deps.config.maxInboundLength),
      );
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
        await switchToProject(deps, "telegram", sessionName);
        await reply(ctx, "ok", messages("telegram").switched, {
          session: sessionName,
          replyTarget,
        });
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
        replyTarget.removeSession(sessionName);
        await removeProjectBySession(deps, sessionName);
        await reply(ctx, "ok", messages("telegram").removed, { session: sessionName, replyTarget });
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

    const currentSessionName = targetSession ?? (await deps.currentProject.get("telegram"));
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
