import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { executeMessage } from "../../core/dispatch.js";
import type { QueuedMessage } from "../../core/queue.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import { setWhisperLanguage } from "../../core/voice-support.js";
import { normalizeError } from "../../shared/utils/error.js";
import { logger } from "../../shared/utils/logger.js";
import { timeApi } from "../../shared/utils/timing.js";
import { safeAnswerCallback } from "./callback-utils.js";
import {
  buildControlKeyboard,
  buildExpandedControlKeyboard,
  buildProjectDeleteKeyboard,
  buildProjectKeyboard,
  buildVoiceLangKeyboard,
  parseCallbackData,
} from "./keyboards.js";
import { MSG } from "./messages.js";
import {
  addRecentProjectBySid,
  aliveProjectButtons,
  botSelfRepoWarning,
  removeProjectBySession,
  resolveAliveSessionByShortId,
  switchToProject,
} from "./project-ops.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { sendAliveList, sendHistory, sendPeek, sendQueueStatus } from "./views.js";

/**
 * Dispatch an inline-keyboard tap. The callback data (parsed by
 * `parseCallbackData`) names the intent; most branches answer the callback
 * (to clear the client's spinner) and then either swap the keyboard in place,
 * run a project operation, or render a view.
 */
export async function handleCallbackQuery(
  ctx: Context,
  deps: HandlerDeps,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const parsed = parseCallbackData(ctx.callbackQuery?.data ?? "");
  try {
    if (!parsed) {
      await safeAnswerCallback(ctx);
      return;
    }
    // Expand/collapse the control panel — purely cosmetic, swap the keyboard
    // in place; no session work needed.
    if (parsed.kind === "more" || parsed.kind === "less") {
      const kb =
        parsed.kind === "more"
          ? buildExpandedControlKeyboard(parsed.sid)
          : buildControlKeyboard(parsed.sid);
      await safeAnswerCallback(ctx);
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({ reply_markup: kb }),
        );
      } catch {
        /* message may be gone or unchanged */
      }
      return;
    }
    // Toggle the project list between switch mode and delete mode — re-fetch
    // the live project list and swap the keyboard in place.
    if (parsed.kind === "delmode" || parsed.kind === "dellist") {
      const buttons = await aliveProjectButtons(deps, "telegram");
      const kb =
        parsed.kind === "delmode"
          ? buildProjectDeleteKeyboard(buttons)
          : buildProjectKeyboard(buttons);
      await safeAnswerCallback(ctx);
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({ reply_markup: kb }),
        );
      } catch {
        /* message may be gone or unchanged */
      }
      return;
    }
    // Global view actions — no session needed.
    if (parsed.kind === "listalive") {
      await safeAnswerCallback(ctx);
      await sendAliveList(ctx, deps);
      return;
    }
    if (parsed.kind === "queuestatus") {
      await safeAnswerCallback(ctx);
      await sendQueueStatus(ctx, deps);
      return;
    }
    // Voice-language pick: set it live + persist, confirm via toast, and refresh
    // the picker in place so the ✅ moves to the new selection.
    if (parsed.kind === "voicelang") {
      setWhisperLanguage("telegram", parsed.lang);
      logger.info(`[voice-lang] telegram set to ${parsed.lang} via button`);
      await safeAnswerCallback(ctx, MSG.voiceLangSet(parsed.lang));
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({ reply_markup: buildVoiceLangKeyboard(parsed.lang) }),
        );
      } catch {
        /* message may be gone or unchanged */
      }
      return;
    }
    // Recreate/switch a recent project — resolves by recent path, not by an
    // alive session, so it runs before the alive-session lookup below.
    if (parsed.kind === "add") {
      await safeAnswerCallback(ctx, "➕ 处理中…");
      await addRecentProjectBySid(deps, ctx, parsed.sid, replyTarget);
      return;
    }
    const sessionName = await resolveAliveSessionByShortId(deps, parsed.sid);
    if (!sessionName) {
      await safeAnswerCallback(ctx, "会话不存在或已结束");
      return;
    }
    if (parsed.kind === "switch") {
      await switchToProject(deps, "telegram", sessionName);
      await safeAnswerCallback(ctx, "✅ 已切换");
      const warn = botSelfRepoWarning(getPathBySession(sessionName));
      await reply(ctx, "ok", warn ? `已切换\n\n${warn}` : "已切换", {
        session: sessionName,
        replyTarget,
      });
      return;
    }
    if (parsed.kind === "remove") {
      await safeAnswerCallback(ctx, "🗑 移除中…");
      replyTarget.removeSession(sessionName);
      await removeProjectBySession(deps, sessionName);
      await reply(ctx, "ok", "已移除", { session: sessionName, replyTarget });
      return;
    }
    if (parsed.kind === "peek") {
      await safeAnswerCallback(ctx);
      await sendPeek(ctx, deps, sessionName, replyTarget);
      return;
    }
    if (parsed.kind === "history") {
      await safeAnswerCallback(ctx);
      await sendHistory(ctx, deps, sessionName, 0, replyTarget);
      return;
    }
    // Control action — verb already validated as a safe MessageAction.
    await safeAnswerCallback(ctx, `已发送 /${parsed.action}`);
    const result = await executeMessage(
      { sessionName, action: parsed.action, id: "" } as QueuedMessage,
      deps,
    );
    await reply(ctx, "info", result, { session: sessionName, replyTarget });
  } catch (err) {
    logger.error(`[callback] error: ${normalizeError(err).message}`);
    await safeAnswerCallback(ctx, "出错了");
  }
}
