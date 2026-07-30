import { spawnSync } from "node:child_process";
import type { Context } from "grammy";
import { getAgentRuntimeRecord } from "../../core/agents/agent-runtime-records.js";
import { resolveAgentKind } from "../../core/agents/agentKindMap.js";
import { orphanLabel } from "../../core/agents/takeover.js";
import {
  adoptOrphan,
  attachCommand,
  composeAdoptOutcome,
  findAdoptableOrphans,
} from "../../core/agents/takeover-service.js";
import { findProjectAutomationConflictForSession } from "../../core/automation/project-conflicts.js";
import {
  cancelActiveDelegatedTask,
  formatActiveDelegateCancel,
  formatActiveDelegateStart,
  parseDelegateRequirement,
  startActiveDelegatedTask,
} from "../../core/autopilot/delegated-task.js";
import { planMessageAction } from "../../core/command/action-plan.js";
import { executeMessage, performRestart, performStart } from "../../core/command/dispatch.js";
import type { QueuedMessage } from "../../core/command/queue.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages, resolveUiLang, setUiLang, UI_LANGS } from "../../core/i18n/index.js";
import { OpportunityStore } from "../../core/opportunities/store.js";
import { formatOpportunityBatchAgentDiscussionPrompt } from "../../core/opportunities/view.js";
import {
  browseCwd,
  clearBrowse,
  displayPath,
  requestNewFolder,
  resolveBrowseAction,
} from "../../core/projects/dir-browser.js";
import { clearFreeLabel, requestFreeLabel } from "../../core/projects/free-label-prompt.js";
import { createProjectFromPath } from "../../core/projects/project-ops.js";
import { projectPickerRows } from "../../core/projects/project-session-picker.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import {
  makePromptLib,
  resolvePromptByShortId,
  resolveTagByShortId,
} from "../../core/promptlib/promptlib.js";
import { runOptionalFeatureInstall } from "../../core/read/optional-feature-install.js";
import {
  applyPromptTranslateCommand,
  formatPromptTranslateCommandResult,
  installPromptTranslation,
  promptTranslateStatus,
} from "../../core/read/prompt-translation.js";
import { DEFAULT_INPUTS, lookupInput } from "../../core/read/recent-inputs.js";
import {
  checkVoiceSupport,
  installVoice,
  isVoicePlatformSupported,
  resolveWhisperLanguage,
  setWhisperLanguage,
} from "../../core/read/voice-support.js";
import { recoverProjects } from "../../core/recovery/recover.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { timeApi } from "../../shared/utils/timing.js";
import { safeAnswerCallback } from "./callback-utils.js";
import { enqueueSessionCommand } from "./executor.js";
import {
  actionConfirmationBody,
  buildActionConfirmationKeyboard,
  buildAdoptConfirmKeyboard,
  buildAdoptDoneKeyboard,
  buildBrowseKeyboard,
  buildControlKeyboard,
  buildExpandedControlKeyboard,
  buildFreeLabelKeyboard,
  buildLangKeyboard,
  buildOpportunityNotificationKeyboard,
  buildProjectDeleteKeyboard,
  buildProjectKeyboard,
  buildPromptTranslateKeyboard,
  buildStartPickerKeyboard,
  buildVoiceInstallKeyboard,
  buildVoiceLangKeyboard,
  parseCallbackData,
} from "./keyboards.js";
import { MSG } from "./messages.js";
import {
  addRecentProjectBySid,
  botSelfRepoWarning,
  removeProjectBySession,
  resolveAliveSessionByShortId,
  switchToProject,
} from "./project-ops.js";
import { sendPromptsPage } from "./prompts.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { tgScope } from "./scope.js";
import {
  browseText,
  replyCreateProject,
  sendAliveList,
  sendHistory,
  sendInputs,
  sendPeek,
  sendQueueStatus,
  sendRecoverPreview,
  sendStatusInstall,
} from "./views.js";

const log = createLogger("telegram.callbacks");

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
    if (parsed.kind === "noop") {
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
    // Autopilot now means supervisor-backed delegation only. The old
    // keep-alive/goal-cycle callbacks are intentionally not handled here.
    if (parsed.kind === "apDelegate" || parsed.kind === "apCancelDelegate") {
      await safeAnswerCallback(ctx);
      const session = await resolveAliveSessionByShortId(deps, parsed.sid);
      if (!session) return;
      if (parsed.kind === "apDelegate") {
        const requirement = parseDelegateRequirement("delegate");
        if (requirement === null) return;
        const result = await startActiveDelegatedTask(deps, { session, requirement });
        await reply(
          ctx,
          result.status === "queued" ? "ok" : "err",
          messages("telegram").autopilotTitle,
          {
            session,
            body: formatActiveDelegateStart(result),
            replyTarget,
          },
        );
      } else {
        const result = await cancelActiveDelegatedTask(deps, { session });
        await reply(
          ctx,
          result.status === "cancelled" ? "ok" : "err",
          messages("telegram").autopilotTitle,
          {
            session,
            body: formatActiveDelegateCancel(result),
            replyTarget,
          },
        );
      }
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({ reply_markup: buildExpandedControlKeyboard(parsed.sid) }),
        );
      } catch {
        /* message gone/unchanged */
      }
      return;
    }
    if (parsed.kind === "apBack" || parsed.kind === "apConfirm" || parsed.kind === "apContinue") {
      await safeAnswerCallback(ctx, "旧 Autopilot 保活/目标入口已下线");
      return;
    }
    if (parsed.kind === "opportunityDiscussAll" || parsed.kind === "opportunityDismissAll") {
      await handleOpportunityCallback(ctx, deps, replyTarget, parsed);
      return;
    }
    // Toggle the project list between switch mode and delete mode — re-fetch
    // the live project list and swap the keyboard in place.
    if (parsed.kind === "delmode" || parsed.kind === "dellist") {
      const buttons = await projectPickerRows(deps, tgScope(ctx), "project-sessions");
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
    // New independent-session tap: arm the label capture, then prompt. The next
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
    // Cancel a still-waiting queued message via the ❌ on its "queued" ack. The
    // reject closure (see executor) posts the localized "已取消" confirmation, so
    // here we only toast + drop the now-stale button.
    if (parsed.kind === "qcancel") {
      const m = messages("telegram");
      const session = await resolveAliveSessionByShortId(deps, parsed.sid);
      const cancelled =
        session !== null && deps.queue.cancelQueued(session, parsed.msgId, m.queueItemCancelled);
      // The reject closure already posts the "已取消" reply on success; on false the
      // item is gone (dispatched / deduped phantom) — toast that, don't imply success.
      await safeAnswerCallback(ctx, cancelled ? m.queueItemCancelled : m.queueItemGone);
      try {
        await timeApi("editMessageReplyMarkup", () => ctx.editMessageReplyMarkup());
      } catch {
        /* message may be gone */
      }
      return;
    }
    if (parsed.kind === "voicelangmenu") {
      await safeAnswerCallback(ctx);
      const current = resolveWhisperLanguage("telegram");
      if (!checkVoiceSupport().ready) {
        await reply(ctx, "info", MSG.voiceNotInstalled, {
          replyTarget,
          replyMarkup: buildVoiceInstallKeyboard(),
        });
      } else {
        await reply(ctx, "info", MSG.voiceLangCurrent(current), {
          replyTarget,
          replyMarkup: buildVoiceLangKeyboard(current),
        });
      }
      return;
    }
    if (parsed.kind === "voiceinstall") {
      await safeAnswerCallback(ctx);
      await runOptionalFeatureInstall({
        copy: {
          installing: MSG.voiceInstalling,
          ok: MSG.voiceInstallOk,
          alreadyReady: MSG.voiceAlreadyInstalled,
          inProgress: MSG.voiceInstalling,
          unsupported: MSG.voiceUnsupported,
          failed: MSG.voiceInstallFailed,
        },
        precheck: () => {
          if (checkVoiceSupport().ready) return { status: "already-ready" };
          if (!isVoicePlatformSupported()) return { status: "unsupported" };
          return null;
        },
        install: () => installVoice(),
        send: async (notice) => {
          await reply(ctx, notice.tone, notice.text, { replyTarget });
        },
        background: true,
      });
      return;
    }
    // Voice-language pick: set it live + persist, confirm via toast, and refresh
    // the picker in place so the ✅ moves to the new selection.
    if (parsed.kind === "voicelang") {
      setWhisperLanguage("telegram", parsed.lang);
      log.info(`telegram set to ${parsed.lang} via button`);
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
    if (parsed.kind === "uilangmenu") {
      await safeAnswerCallback(ctx);
      const current = resolveUiLang("telegram");
      await reply(ctx, "info", messages("telegram").uiLangCurrent(current), {
        replyTarget,
        replyMarkup: buildLangKeyboard(current),
      });
      return;
    }
    // UI-language pick: set + persist, then refresh the picker in place.
    if (parsed.kind === "uilang") {
      setUiLang("telegram", parsed.lang);
      log.info(`telegram set to ${parsed.lang} via button`);
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
    if (parsed.kind === "prompttranslatemenu") {
      await safeAnswerCallback(ctx);
      const current = promptTranslateStatus("telegram");
      await reply(ctx, "info", formatPromptTranslateCommandResult(current), {
        replyTarget,
        replyMarkup: buildPromptTranslateKeyboard(),
      });
      return;
    }
    if (parsed.kind === "prompttranslate") {
      await safeAnswerCallback(ctx);
      const result = await applyPromptTranslateCommand("telegram", parsed.arg);
      const current = promptTranslateStatus("telegram");
      await reply(
        ctx,
        result.ok ? "info" : "err",
        result.ok
          ? formatPromptTranslateCommandResult(current)
          : formatPromptTranslateCommandResult(result),
        {
          replyTarget,
          replyMarkup: buildPromptTranslateKeyboard(),
        },
      );
      return;
    }
    if (parsed.kind === "prompttranslateinstall") {
      await safeAnswerCallback(ctx);
      const m = messages("telegram");
      await runOptionalFeatureInstall({
        copy: {
          installing: m.promptTranslateInstalling,
          ok: m.promptTranslateInstallOk,
          alreadyReady: m.promptTranslateAlreadyInstalled,
          inProgress: m.promptTranslateInstalling,
          failed: m.promptTranslateInstallFailed,
        },
        install: () => installPromptTranslation(),
        send: async (notice) => {
          await reply(ctx, notice.tone, notice.text, { replyTarget });
        },
        background: true,
      });
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
      // Resolve the live kind before exit — resolveAgentKind self-persists it,
      // so the post-exit dispatch resumes with the right runner (live detection
      // returns null once it's gone).
      await resolveAgentKind(deps.configResolver, sessionName);
      deps.queue.clearSession(sessionName);
      await deps.bridge.sendExit(sessionName);
      await sleep(2000);
      // Resume with the recorded launch flavor (e.g. claude-stella), not the
      // runner default, so the resumed session keeps its CLAUDE_CONFIG_DIR/flags.
      await deps.agent.startWithResume(
        sessionName,
        parsed.sessionId,
        getAgentRuntimeRecord(sessionName).startCommand ?? undefined,
      );
      deps.configResolver.invalidate(sessionName);
      await reply(ctx, "ok", messages("telegram").resumeStarted(parsed.sessionId.slice(0, 8)), {
        session: sessionName,
        replyTarget,
      });
      return;
    }
    // Adopt an unmanaged claude: tapping a candidate shows a confirm first, since
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
      const result = await adoptOrphan(
        parsed.pid,
        {
          bridge: deps.bridge,
          configResolver: deps.configResolver,
          projectSessionPrefix: deps.config.projectSessionPrefix,
          warmupMs: deps.config.sessionWarmupMs,
        },
        { target: parsed.target },
      );
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
    // Reboot recovery: panel button → show the preview (mirrors the /recover command).
    if (parsed.kind === "recoverlist") {
      await safeAnswerCallback(ctx);
      await sendRecoverPreview(ctx, deps, replyTarget);
      return;
    }
    // Reboot recovery confirm: recreate every gone session + relaunch its agent.
    if (parsed.kind === "recover") {
      await safeAnswerCallback(ctx, messages("telegram").recoverWorking);
      const res = await recoverProjects(deps);
      if (res.busy) {
        await reply(ctx, "info", messages("telegram").recoverBusy, { replyTarget });
        return;
      }
      await reply(
        ctx,
        res.failed.length > 0 ? "err" : "ok",
        messages("telegram").recoverDone(
          res.launched.length,
          res.shellOnly.length,
          res.alreadyAlive.length,
          res.failed.length,
        ),
        { replyTarget },
      );
      return;
    }
    if (parsed.kind === "recovercancel") {
      await safeAnswerCallback(ctx, messages("telegram").recoverCancelled);
      return;
    }
    // "View on computer": show the attach command on demand. Do not mutate the
    // host clipboard from a remote chat callback; it is surprising and can
    // overwrite unrelated clipboard contents.
    if (parsed.kind === "adoptattach") {
      const session = await resolveAliveSessionByShortId(deps, parsed.sid);
      if (!session) {
        await safeAnswerCallback(ctx, messages("telegram").sessionGone);
        return;
      }
      await safeAnswerCallback(ctx);
      await reply(ctx, "ok", messages("telegram").adoptAttachHint(attachCommand(session)), {
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
    // A picked input — its session comes from the cache, not a short id, so it's
    // handled BEFORE the short-id session resolution below.
    if (parsed.kind === "inputredo") {
      const found = lookupInput(parsed.token, parsed.idx);
      if (!found) {
        await safeAnswerCallback(ctx, messages("telegram").inputsExpired);
        return;
      }
      // Don't auto-send — hand the verbatim prompt back as an editable draft so the
      // user can tweak it before sending. Raw ctx.reply (no tone emoji / no tildeify)
      // keeps the text EXACTLY as typed and cleanly copyable.
      await safeAnswerCallback(ctx, messages("telegram").inputDraftToast);
      await ctx.reply(found.prompt);
      return;
    }
    if (parsed.kind === "promptget") {
      await safeAnswerCallback(ctx);
      const lib = makePromptLib(deps.config);
      if (!lib.isEnabled()) {
        await reply(ctx, "info", messages("telegram").promptsDisabled, { replyTarget });
        return;
      }
      const name = await resolvePromptByShortId(lib, parsed.sid);
      if (!name) {
        await reply(ctx, "err", messages("telegram").promptsGone, { replyTarget });
        return;
      }
      const body = await lib.get(name);
      await reply(ctx, "result", name, { replyTarget, body, code: true });
      return;
    }
    if (parsed.kind === "promptfilter" || parsed.kind === "promptpage") {
      await safeAnswerCallback(ctx);
      const lib = makePromptLib(deps.config);
      if (!lib.isEnabled()) {
        await reply(ctx, "info", messages("telegram").promptsDisabled, { replyTarget });
        return;
      }
      const tags = await lib.listTags();
      const tagSid = parsed.kind === "promptfilter" ? parsed.tagSid : parsed.tagSid;
      const tagFilter = tagSid ? ((await resolveTagByShortId(lib, tagSid, tags)) ?? "") : "";
      const page = parsed.kind === "promptpage" ? parsed.page : 0;
      await sendPromptsPage(ctx, lib, page, tagFilter, replyTarget, tags);
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
    if (parsed.kind === "inputslist") {
      await safeAnswerCallback(ctx);
      await sendInputs(ctx, deps, sessionName, replyTarget, DEFAULT_INPUTS);
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
      let msg: string;
      if (restart) {
        await performRestart(deps, sessionName, pick.command);
        msg = messages("telegram").agentStartedWith(pick.label);
      } else {
        const r = await performStart(deps, sessionName, pick.command);
        msg =
          r === "already-running"
            ? messages("telegram").agentAlreadyRunning
            : messages("telegram").agentStartedWith(pick.label);
      }
      await reply(ctx, "ok", msg, { session: sessionName, replyTarget });
      return;
    }
    const planned = await planMessageAction({
      deps,
      action: parsed.action,
      confirmed: parsed.kind === "actconfirm",
      session: sessionName,
      text: parsed.action,
    });

    if (planned.kind === "confirm") {
      await safeAnswerCallback(ctx);
      await reply(ctx, "warn", actionConfirmationBody(planned.action, sessionName), {
        session: sessionName,
        replyMarkup: buildActionConfirmationKeyboard(planned.action, parsed.sid),
        replyTarget,
      });
      return;
    }

    if (planned.kind === "already-running") {
      await safeAnswerCallback(ctx);
      await reply(ctx, "ok", messages("telegram").agentAlreadyRunning, {
        session: sessionName,
        replyTarget,
      });
      return;
    }

    if (planned.kind === "pick-start-command") {
      await safeAnswerCallback(ctx);
      await reply(ctx, "info", messages("telegram").startPickerPrompt, {
        session: sessionName,
        replyMarkup: buildStartPickerKeyboard(
          deps.config.startCommands,
          parsed.sid,
          planned.action,
        ),
        replyTarget,
      });
      return;
    }

    if (planned.kind === "immediate") {
      await safeAnswerCallback(ctx, messages("telegram").toastSent(planned.action));
      const result = await executeMessage(
        { sessionName, action: planned.action, id: "" } as QueuedMessage,
        deps,
      );
      await reply(ctx, "info", result, { session: sessionName, replyTarget });
      return;
    }

    if (planned.kind === "queued") {
      await safeAnswerCallback(ctx, messages("telegram").toastSent(planned.action));
      await enqueueSessionCommand(ctx, deps, sessionName, planned.action, planned.text);
      return;
    }
  } catch (err) {
    log.error("callback handler failed", { err });
    await safeAnswerCallback(ctx, messages("telegram").toastError);
  }
}

async function handleOpportunityCallback(
  ctx: Context,
  deps: HandlerDeps,
  replyTarget: ReplyTargetMap,
  parsed:
    | { kind: "opportunityDiscussAll"; tokens: string[] }
    | { kind: "opportunityDismissAll"; tokens: string[] },
): Promise<void> {
  const store = new OpportunityStore();
  const resolved = resolveOpportunityTokens(store, parsed.tokens);
  if (resolved.missing.length > 0 || resolved.suggestions.length === 0) {
    await safeAnswerCallback(ctx, "Opportunity not found");
    await reply(ctx, "err", `Opportunity not found: ${resolved.missing.join(", ")}`, {
      replyTarget,
    });
    return;
  }

  if (parsed.kind === "opportunityDismissAll") {
    let skipped = 0;
    for (const suggestion of resolved.suggestions) {
      if (store.updateStatus(suggestion.id, "dismissed") !== null) skipped++;
    }
    await safeAnswerCallback(ctx, "Skipped");
    await reply(ctx, "ok", `Skipped ${skipped} opportunities.`, { replyTarget });
    try {
      await timeApi("editMessageReplyMarkup", () => ctx.editMessageReplyMarkup());
    } catch {
      /* message may be gone */
    }
    return;
  }

  const first = resolved.suggestions[0];
  if (first === undefined) return;
  if (resolved.suggestions.some((suggestion) => suggestion.projectPath !== first.projectPath)) {
    await safeAnswerCallback(ctx, "Mixed projects are not supported");
    await reply(ctx, "err", "Cannot discuss mixed-project opportunities together.", {
      replyTarget,
    });
    return;
  }
  const opened = await createProjectFromPath(deps, tgScope(ctx), first.projectPath);
  if (opened.status !== "created" && opened.status !== "switched") {
    const reason =
      opened.status === "invalid" ? `${opened.error}: ${opened.resolvedPath}` : opened.message;
    await safeAnswerCallback(ctx, "Cannot open project");
    await reply(ctx, "err", `Cannot open project for discussion: ${reason}`, { replyTarget });
    return;
  }
  const blocked = opportunityDiscussionBlockReason(deps, opened.sessionName, opened.projectPath);
  if (blocked !== null) {
    await safeAnswerCallback(ctx, "Blocked");
    await reply(ctx, "warn", blocked, { replyTarget });
    return;
  }

  for (const suggestion of resolved.suggestions) store.updateStatus(suggestion.id, "discussing");
  await safeAnswerCallback(ctx, "Discussion started");
  await reply(ctx, "info", `Discussing ${resolved.suggestions.length} opportunities.`, {
    session: opened.sessionName,
    replyTarget,
    replyMarkup: buildOpportunityNotificationKeyboard(
      resolved.suggestions.map((suggestion) => ({
        id: suggestion.id,
        title: suggestion.title,
        projectName: suggestion.projectName,
        category: suggestion.category,
        confidence: suggestion.confidence,
        estimatedComplexity: suggestion.estimatedComplexity,
        status: "discussing",
        value: suggestion.value,
      })),
    ),
  });
  await enqueueSessionCommand(
    ctx,
    deps,
    opened.sessionName,
    "text",
    formatOpportunityBatchAgentDiscussionPrompt(resolved.suggestions),
  );
}

function resolveOpportunityTokens(
  store: OpportunityStore,
  tokens: string[],
): {
  suggestions: NonNullable<ReturnType<OpportunityStore["get"]>>[];
  missing: string[];
} {
  const all = store.list();
  const suggestions: NonNullable<ReturnType<OpportunityStore["get"]>>[] = [];
  const missing: string[] = [];
  for (const token of tokens) {
    const matches = all.filter((suggestion) => suggestion.id.endsWith(`-${token}`));
    if (matches.length === 1 && matches[0] !== undefined) {
      suggestions.push(matches[0]);
    } else {
      missing.push(token);
    }
  }
  return { suggestions, missing };
}

function opportunityDiscussionBlockReason(
  deps: HandlerDeps,
  session: string,
  projectPath: string,
): string | null {
  const conflict = findProjectAutomationConflictForSession(session);
  if (conflict !== null) {
    return `项目正在执行自动化任务，暂时不能参与讨论。请等当前任务完成后再试。\n\n任务：${conflict.taskKind}\nRun：${conflict.runId}\nSupervisor：${conflict.supervisorSession}`;
  }

  if (
    deps.queue.isSessionProcessing(session) ||
    deps.queue.getCurrentSessionMessage(session) !== undefined ||
    deps.queue.getSessionQueue(session).length > 0
  ) {
    return "项目 agent 当前正在处理任务或已有排队消息，暂时不能参与讨论。请等当前任务完成后再试。";
  }

  const status = spawnSync("git", ["status", "--short"], {
    cwd: projectPath,
    encoding: "utf8",
  });
  if (status.status !== 0) {
    const reason = [status.stderr, status.stdout].filter(Boolean).join("\n").trim();
    return `无法确认项目 git 状态，暂时不能参与讨论。\n${reason || "git status --short failed"}`;
  }
  const dirty = status.stdout.trim();
  if (dirty.length > 0) {
    const preview = dirty.split(/\r?\n/).slice(0, 12).join("\n");
    return `项目工作区不干净，暂时不能参与讨论。请先处理现有改动后再试。\n\n${preview}`;
  }
  return null;
}
