import type { Context } from "grammy";
import { resolveAgentKind } from "../../core/agents/agentKindMap.js";
import { getStartCommand } from "../../core/agents/startCommandMap.js";
import { orphanLabel } from "../../core/agents/takeover.js";
import {
  adoptOrphan,
  composeAdoptOutcome,
  copyAttachCommand,
  findAdoptableOrphans,
} from "../../core/agents/takeover-service.js";
import { buildAutopilotView } from "../../core/autopilot/autopilot-view.js";
import { applyAutopilotVerb, goalsVerb } from "../../core/autopilot/controls.js";
import { listGoals } from "../../core/autopilot/goals/catalog.js";
import {
  adjustRounds,
  clearPicker,
  getPicker,
  toggleGoal,
} from "../../core/autopilot/picker-state.js";
import { AutopilotStore } from "../../core/autopilot/state-store.js";
import {
  executeMessage,
  performRestart,
  performStart,
  startDisposition,
} from "../../core/command/dispatch.js";
import type { QueuedMessage } from "../../core/command/queue.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages, setUiLang, UI_LANGS } from "../../core/i18n/index.js";
import {
  browseCwd,
  clearBrowse,
  displayPath,
  requestNewFolder,
  resolveBrowseAction,
} from "../../core/projects/dir-browser.js";
import { clearFreeLabel, requestFreeLabel } from "../../core/projects/free-label-prompt.js";
import { createProjectFromPath } from "../../core/projects/project-ops.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import {
  makePromptLib,
  resolvePromptByShortId,
  resolveTagByShortId,
} from "../../core/promptlib/promptlib.js";
import { DEFAULT_INPUTS, lookupInput } from "../../core/read/recent-inputs.js";
import { setWhisperLanguage } from "../../core/read/voice-support.js";
import { recoverProjects } from "../../core/recovery/recover.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { timeApi } from "../../shared/utils/timing.js";
import { safeAnswerCallback } from "./callback-utils.js";
import {
  buildAdoptConfirmKeyboard,
  buildAdoptDoneKeyboard,
  buildAutopilotGoalPicker,
  buildAutopilotPanelKeyboard,
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
    // Autopilot panel: open, toggle on/off, global on/off, stop, back.
    if (
      parsed.kind === "apPanel" ||
      parsed.kind === "apToggle" ||
      parsed.kind === "apGlobal" ||
      parsed.kind === "apStop" ||
      parsed.kind === "apBack"
    ) {
      await safeAnswerCallback(ctx);
      const session = await resolveAliveSessionByShortId(deps, parsed.sid);
      if (!session) return;
      const store = new AutopilotStore();
      const m = messages("telegram");
      if (parsed.kind === "apToggle") {
        applyAutopilotVerb(store, session, store.get(session).enabled ? "off" : "on", m);
      } else if (parsed.kind === "apGlobal") {
        applyAutopilotVerb(store, session, `global ${parsed.on ? "on" : "off"}`, m);
      } else if (parsed.kind === "apStop") {
        applyAutopilotVerb(store, session, "stop", m);
      }
      // apBack → return to the control keyboard; everything else → re-render the panel
      const kb =
        parsed.kind === "apBack"
          ? buildExpandedControlKeyboard(parsed.sid)
          : buildAutopilotPanelKeyboard(buildAutopilotView(store, session, m), parsed.sid);
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({ reply_markup: kb }),
        );
      } catch {
        /* message gone/unchanged */
      }
      return;
    }
    // Autopilot goal picker: open picker, toggle a goal, adjust rounds, start cycle.
    if (
      parsed.kind === "apPick" ||
      parsed.kind === "apGoalToggle" ||
      parsed.kind === "apRounds" ||
      parsed.kind === "apStart"
    ) {
      await safeAnswerCallback(ctx);
      const session = await resolveAliveSessionByShortId(deps, parsed.sid);
      if (!session) return;
      const store = new AutopilotStore();
      const m = messages("telegram");
      const goals = listGoals();
      if (parsed.kind === "apGoalToggle") {
        const g = goals[parsed.idx];
        if (g) toggleGoal(session, g.id);
      } else if (parsed.kind === "apRounds") {
        adjustRounds(session, parsed.delta, deps.config.autopilot.maxRounds);
      } else if (parsed.kind === "apStart") {
        const sel = getPicker(session).selected;
        if (sel.length > 0) {
          applyAutopilotVerb(
            store,
            session,
            goalsVerb(sel, getPicker(session).rounds),
            m,
            deps.config.autopilot.maxRounds,
          );
          clearPicker(session);
          // back to the panel showing the running cycle
          const kb = buildAutopilotPanelKeyboard(buildAutopilotView(store, session, m), parsed.sid);
          try {
            await timeApi("editMessageReplyMarkup", () =>
              ctx.editMessageReplyMarkup({ reply_markup: kb }),
            );
          } catch {
            /* gone/unchanged */
          }
          return;
        }
      }
      // re-render the picker
      const kb = buildAutopilotGoalPicker(buildAutopilotView(store, session, m), parsed.sid);
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({ reply_markup: kb }),
        );
      } catch {
        /* gone/unchanged */
      }
      return;
    }
    // Autopilot human gate: confirm (mark done) or continue (keep polishing).
    if (parsed.kind === "apConfirm" || parsed.kind === "apContinue") {
      await safeAnswerCallback(ctx);
      const session = await resolveAliveSessionByShortId(deps, parsed.sid);
      if (!session) return;
      const store = new AutopilotStore();
      const m = messages("telegram");
      applyAutopilotVerb(store, session, parsed.kind === "apConfirm" ? "confirm" : "reject", m);
      try {
        await timeApi("editMessageReplyMarkup", () =>
          ctx.editMessageReplyMarkup({
            reply_markup: buildAutopilotPanelKeyboard(
              buildAutopilotView(store, session, m),
              parsed.sid,
            ),
          }),
        );
      } catch {
        /* gone/unchanged */
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
        getStartCommand(sessionName) ?? undefined,
      );
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
      const tagSid = parsed.kind === "promptfilter" ? parsed.tagSid : (parsed.tagSid ?? "");
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
    // start/restart buttons: reject a start when already running, else show the
    // flavor picker (multi-command) or fall through to the single-command action.
    if (parsed.action === "start" || parsed.action === "restart") {
      const mode = parsed.action === "restart" ? "restart" : "start";
      const disp = await startDisposition(deps, sessionName, mode);
      if (disp === "already-running") {
        await safeAnswerCallback(ctx);
        await reply(ctx, "ok", messages("telegram").agentAlreadyRunning, {
          session: sessionName,
          replyTarget,
        });
        return;
      }
      if (disp === "pick") {
        await safeAnswerCallback(ctx);
        await reply(ctx, "info", messages("telegram").startPickerPrompt, {
          session: sessionName,
          replyMarkup: buildStartPickerKeyboard(deps.config.startCommands, parsed.sid, mode),
          replyTarget,
        });
        return;
      }
    }
    // Control action — verb already validated as a safe MessageAction.
    await safeAnswerCallback(ctx, messages("telegram").toastSent(parsed.action));
    const result = await executeMessage(
      { sessionName, action: parsed.action, id: "" } as QueuedMessage,
      deps,
    );
    await reply(ctx, "info", result, { session: sessionName, replyTarget });
  } catch (err) {
    log.error("callback handler failed", { err });
    await safeAnswerCallback(ctx, messages("telegram").toastError);
  }
}
