import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import {
  browseCwd,
  clearBrowse,
  displayPath,
  requestNewFolder,
  resolveBrowseAction,
} from "../../core/dir-browser.js";
import { executeMessage, performRestart, performStart } from "../../core/dispatch.js";
import { clearFreeLabel, requestFreeLabel } from "../../core/free-label-prompt.js";
import { messages, setUiLang, UI_LANGS } from "../../core/i18n/index.js";
import { createProjectFromPath } from "../../core/project-ops.js";
import type { QueuedMessage } from "../../core/queue.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import { orphanLabel } from "../../core/takeover.js";
import {
  adoptOrphan,
  composeAdoptOutcome,
  copyAttachCommand,
  findAdoptableOrphans,
} from "../../core/takeover-service.js";
import { setWhisperLanguage } from "../../core/voice-support.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { logger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { timeApi } from "../../shared/utils/timing.js";
import { safeAnswerCallback } from "./callback-utils.js";
import {
  buildAdoptConfirmKeyboard,
  buildAdoptDoneKeyboard,
  buildBrowseKeyboard,
  buildControlKeyboard,
  buildExpandedControlKeyboard,
  buildFreeLabelKeyboard,
  buildLangKeyboard,
  buildProjectDeleteKeyboard,
  buildProjectKeyboard,
  buildStartPickerKeyboard,
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
import { tgScope } from "./scope.js";
import {
  browseText,
  replyCreateProject,
  sendAliveList,
  sendHistory,
  sendPeek,
  sendQueueStatus,
  sendStatusInstall,
} from "./views.js";

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
      const buttons = await aliveProjectButtons(deps, tgScope(ctx));
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
    // "🆓 new free project" tap: arm the label capture, then prompt. The next
    // text message is taken as the label (see the message handler).
    if (parsed.kind === "newfree") {
      requestFreeLabel(tgScope(ctx));
      await safeAnswerCallback(ctx);
      await reply(ctx, "info", messages("telegram").freeLabelPrompt, {
        replyMarkup: buildFreeLabelKeyboard(),
      });
      return;
    }
    // Cancel an armed label capture (the prompt's cancel button).
    if (parsed.kind === "newfreecancel") {
      clearFreeLabel(tgScope(ctx));
      await safeAnswerCallback(ctx, messages("telegram").freeLabelCancelled);
      try {
        await timeApi("editMessageReplyMarkup", () => ctx.editMessageReplyMarkup());
      } catch {
        /* message may be gone or unchanged */
      }
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
    // UI-language pick: set + persist, then refresh the picker in place.
    if (parsed.kind === "uilang") {
      setUiLang("telegram", parsed.lang);
      logger.info(`[ui-lang] telegram set to ${parsed.lang} via button`);
      const label = UI_LANGS.find((l) => l.code === parsed.lang)?.label ?? parsed.lang;
      await safeAnswerCallback(ctx, messages("telegram").uiLangSet(label));
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({ reply_markup: buildLangKeyboard(parsed.lang) }),
        );
      } catch {
        /* message may be gone or unchanged */
      }
      return;
    }
    // Recreate/switch a recent project — resolves by recent path, not by an
    // alive session, so it runs before the alive-session lookup below.
    if (parsed.kind === "add") {
      await safeAnswerCallback(ctx, messages("telegram").toastProcessing);
      await addRecentProjectBySid(deps, ctx, parsed.sid, replyTarget);
      return;
    }
    // Resume a saved Claude session by UUID — exit the current process and
    // restart with --resume so context is restored from the JSONL transcript.
    if (parsed.kind === "resume") {
      await safeAnswerCallback(ctx, messages("telegram").toastProcessing);
      const scope = tgScope(ctx);
      const sessionName = await deps.currentProject.get(scope);
      if (!sessionName) {
        await reply(ctx, "err", MSG.noSession, { replyTarget });
        return;
      }
      deps.queue.clearSession(sessionName);
      await deps.bridge.sendExit(sessionName);
      await sleep(2000);
      await deps.claude.startWithResume(sessionName, parsed.sessionId);
      deps.configResolver.invalidate(sessionName);
      await reply(ctx, "ok", messages("telegram").resumeStarted(parsed.sessionId.slice(0, 8)), {
        session: sessionName,
        replyTarget,
      });
      return;
    }
    // Adopt a non-tmux claude: tapping a candidate shows a confirm first, since
    // the action interrupts and ends the original process.
    if (parsed.kind === "adoptshow") {
      await safeAnswerCallback(ctx);
      const orphan = (await findAdoptableOrphans()).find((o) => o.pid === parsed.pid);
      if (!orphan) {
        await reply(ctx, "err", messages("telegram").adoptGone, { replyTarget });
        return;
      }
      await reply(ctx, "info", messages("telegram").adoptConfirmPrompt(orphanLabel(orphan)), {
        replyMarkup: buildAdoptConfirmKeyboard(parsed.pid),
        replyTarget,
      });
      return;
    }
    if (parsed.kind === "adoptexec") {
      await safeAnswerCallback(ctx, messages("telegram").adoptWorking);
      const result = await adoptOrphan(parsed.pid, {
        bridge: deps.bridge,
        configResolver: deps.configResolver,
        projectSessionPrefix: deps.config.projectSessionPrefix,
        warmupMs: deps.config.sessionWarmupMs,
      });
      const outcome = composeAdoptOutcome(result, tgScope(ctx));
      if (!outcome.ok) {
        await reply(ctx, "err", outcome.body, { replyTarget });
        return;
      }
      await deps.currentProject.set(tgScope(ctx), outcome.sessionName);
      await reply(ctx, "ok", outcome.body, {
        session: outcome.sessionName,
        replyMarkup: buildAdoptDoneKeyboard(sessionShortId(outcome.sessionName)),
        replyTarget,
      });
      return;
    }
    if (parsed.kind === "adoptcancel") {
      await safeAnswerCallback(ctx, messages("telegram").adoptCancelled);
      return;
    }
    // "View on computer": copy the attach command to the host clipboard on demand
    // (auto-attaching the original terminal isn't possible — see takeover-service).
    if (parsed.kind === "adoptattach") {
      const session = await resolveAliveSessionByShortId(deps, parsed.sid);
      if (!session) {
        await safeAnswerCallback(ctx, messages("telegram").sessionGone);
        return;
      }
      await safeAnswerCallback(ctx);
      await reply(ctx, "ok", messages("telegram").adoptAttachHint(copyAttachCommand(session)), {
        session,
        replyTarget,
      });
      return;
    }
    // Usage-reporting install: the foreign-statusLine choice buttons (si:<action>).
    if (parsed.kind === "statusinstall") {
      await safeAnswerCallback(ctx);
      await sendStatusInstall(ctx, parsed.action, replyTarget);
      return;
    }
    // Directory browser (`br:*`): navigate in place, or create / cancel.
    if (parsed.kind === "browsecancel") {
      clearBrowse(tgScope(ctx));
      await safeAnswerCallback(ctx);
      try {
        await ctx.editMessageText(messages("telegram").browseCancelled);
      } catch {
        /* message may be gone or unchanged */
      }
      return;
    }
    if (parsed.kind === "browseselect") {
      await safeAnswerCallback(ctx);
      const cwd = browseCwd(tgScope(ctx));
      if (!cwd) return; // state expired — nothing to create
      clearBrowse(tgScope(ctx));
      await replyCreateProject(
        ctx,
        deps,
        await createProjectFromPath(deps, tgScope(ctx), cwd),
        replyTarget,
      );
      return;
    }
    if (parsed.kind === "browsenewfolder") {
      await safeAnswerCallback(ctx);
      const cwd = requestNewFolder(tgScope(ctx));
      if (!cwd) return; // not browsing a directory
      // force_reply makes the user's next message a reply, which the text handler
      // recognises as the folder name (no global "expecting input" mode needed).
      await ctx.reply(messages("telegram").browseNewFolderPrompt(displayPath(cwd)), {
        reply_markup: { force_reply: true },
      });
      return;
    }
    if (parsed.kind === "browse") {
      await safeAnswerCallback(ctx);
      const view = resolveBrowseAction(tgScope(ctx), parsed.action, deps.config.cdAllowedDirs);
      try {
        await ctx.editMessageText(browseText(view), { reply_markup: buildBrowseKeyboard(view) });
      } catch {
        /* message may be gone or unchanged */
      }
      return;
    }
    const sessionName = await resolveAliveSessionByShortId(deps, parsed.sid);
    if (!sessionName) {
      await safeAnswerCallback(ctx, messages("telegram").sessionGone);
      return;
    }
    if (parsed.kind === "switch") {
      await switchToProject(deps, tgScope(ctx), sessionName);
      await safeAnswerCallback(ctx, messages("telegram").toastSwitched);
      const warn = botSelfRepoWarning(getPathBySession(sessionName), tgScope(ctx));
      await reply(
        ctx,
        "ok",
        warn ? `${messages("telegram").switched}\n\n${warn}` : messages("telegram").switched,
        {
          session: sessionName,
          replyTarget,
        },
      );
      return;
    }
    if (parsed.kind === "remove") {
      await safeAnswerCallback(ctx, messages("telegram").toastRemoving);
      replyTarget.removeSession(sessionName);
      await removeProjectBySession(deps, sessionName);
      await reply(ctx, "ok", messages("telegram").removed, { session: sessionName, replyTarget });
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
    if (parsed.kind === "startpick" || parsed.kind === "restartpick") {
      const pick = deps.config.startCommands[parsed.idx];
      if (!pick) {
        await safeAnswerCallback(ctx);
        return;
      }
      const restart = parsed.kind === "restartpick";
      await safeAnswerCallback(ctx, messages("telegram").toastSent(restart ? "restart" : "start"));
      if (restart) await performRestart(deps, sessionName, pick.command);
      else await performStart(deps, sessionName, pick.command);
      await reply(ctx, "ok", messages("telegram").claudeStartedWith(pick.label), {
        session: sessionName,
        replyTarget,
      });
      return;
    }
    // Multi-command start/restart: show a picker instead of using the default.
    if (
      (parsed.action === "start" || parsed.action === "restart") &&
      deps.config.startCommands.length > 1
    ) {
      await safeAnswerCallback(ctx);
      await reply(ctx, "info", messages("telegram").startPickerPrompt, {
        session: sessionName,
        replyMarkup: buildStartPickerKeyboard(
          deps.config.startCommands,
          parsed.sid,
          parsed.action === "restart" ? "restart" : "start",
        ),
        replyTarget,
      });
      return;
    }
    // Control action — verb already validated as a safe MessageAction.
    await safeAnswerCallback(ctx, messages("telegram").toastSent(parsed.action));
    const result = await executeMessage(
      { sessionName, action: parsed.action, id: "" } as QueuedMessage,
      deps,
    );
    await reply(ctx, "info", result, { session: sessionName, replyTarget });
  } catch (err) {
    logger.error(`[callback] error: ${normalizeError(err).message}`);
    await safeAnswerCallback(ctx, messages("telegram").toastError);
  }
}
