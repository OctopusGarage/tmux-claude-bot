import type { Bot } from "grammy";
import { buildHelpBody, getTelegramActions } from "../../core/action-registry.js";
import type { HandlerDeps } from "../../core/deps.js";
import { isUiLang, messages, resolveUiLang, setUiLang, UI_LANGS } from "../../core/i18n/index.js";
import { chatScope } from "../../core/project-manager.js";
import { createProjectSession, resolveProjectPath } from "../../core/project-ops.js";
import { appendRecentProject } from "../../core/recentProjects.js";
import {
  getPathBySession,
  sessionNameFromPath,
  setPathForSession,
} from "../../core/sessionPathMap.js";
import {
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  saveWorkspace,
  WORKSPACE_NAME_RE,
} from "../../core/workspaces.js";
import { normalizeError } from "../../shared/utils/error.js";
import { logger } from "../../shared/utils/logger.js";
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
    await reply(ctx, "help", buildHelpBody("telegram", "telegram"));
  });

  for (const action of getTelegramActions()) {
    const a = action;
    bot.command(a, async (ctx) => handleQueuedCommand(ctx, deps, a, undefined, replyTarget));
  }

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
    const { resolvedPath, error } = await resolveProjectPath(
      args.join(" "),
      deps.config.cdAllowedDirs,
    );
    const tm = messages("telegram");
    if (error === "not-a-directory") {
      await reply(ctx, "err", tm.notADir(resolvedPath));
      return;
    }
    if (error === "not-found") {
      await reply(ctx, "err", tm.dirNotExist(resolvedPath));
      return;
    }
    if (error === "not-allowed") {
      await reply(ctx, "err", MSG.pathNotAllowed(deps.config.cdAllowedDirs));
      return;
    }

    const sessionName = sessionNameFromPath(resolvedPath, deps.config.projectSessionPrefix);
    try {
      const exists = await deps.bridge.hasSession(sessionName);
      if (exists) {
        await deps.currentProject.set(
          chatScope("telegram", String(ctx.chat?.id ?? 0)),
          sessionName,
        );
        setPathForSession(sessionName, resolvedPath);
        await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
        await reply(ctx, "warn", messages("telegram").alreadySwitched, {
          session: sessionName,
          replyTarget,
        });
        return;
      }
      await createProjectSession(
        deps,
        chatScope("telegram", String(ctx.chat?.id ?? 0)),
        sessionName,
        resolvedPath,
      );
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
    const session = await deps.currentProject.get(chatScope("telegram", String(ctx.chat?.id ?? 0)));
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
    const buttons = await recentProjectButtons(
      deps,
      chatScope("telegram", String(ctx.chat?.id ?? 0)),
    );
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

  bot.command("ws", async (ctx) => {
    const tm = messages("telegram");
    const raw = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    const name = parts[1];

    if (sub === "list") {
      const all = listWorkspaces();
      if (all.length === 0) {
        await reply(ctx, "list", tm.wsListEmpty);
        return;
      }
      const lines = [tm.wsListTitle, ...all.map((w) => tm.wsListItem(w.name, w.session))];
      await reply(ctx, "list", lines.join("\n"));
      return;
    }

    if (sub === "save") {
      if (!name || !WORKSPACE_NAME_RE.test(name)) {
        await reply(ctx, "err", name ? tm.wsInvalidName : tm.wsUsage);
        return;
      }
      const session = await deps.currentProject.get(
        chatScope("telegram", String(ctx.chat?.id ?? 0)),
      );
      if (!session) {
        await reply(ctx, "err", tm.wsNoCurrentProject);
        return;
      }
      saveWorkspace(name, session);
      await reply(ctx, "ok", tm.wsSaved(name, session));
      return;
    }

    if (sub === "use") {
      if (!name || !WORKSPACE_NAME_RE.test(name)) {
        await reply(ctx, "err", name ? tm.wsInvalidName : tm.wsUsage);
        return;
      }
      const session = getWorkspace(name);
      if (!session) {
        await reply(ctx, "err", tm.wsNotFound(name));
        return;
      }
      if (!(await deps.bridge.hasSession(session))) {
        await reply(ctx, "err", tm.wsSessionGone(name));
        return;
      }
      await deps.currentProject.set(chatScope("telegram", String(ctx.chat?.id ?? 0)), session);
      await reply(ctx, "ok", tm.wsUsed(name));
      return;
    }

    if (sub === "remove") {
      if (!name || !WORKSPACE_NAME_RE.test(name)) {
        await reply(ctx, "err", name ? tm.wsInvalidName : tm.wsUsage);
        return;
      }
      if (!removeWorkspace(name)) {
        await reply(ctx, "err", tm.wsNotFound(name));
        return;
      }
      await reply(ctx, "ok", tm.wsRemoved(name));
      return;
    }

    await reply(ctx, "info", tm.wsUsage);
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
        await switchToProject(deps, chatScope("telegram", String(ctx.chat?.id ?? 0)), sessionName);
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

    const currentSessionName =
      targetSession ??
      (await deps.currentProject.get(chatScope("telegram", String(ctx.chat?.id ?? 0))));
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
