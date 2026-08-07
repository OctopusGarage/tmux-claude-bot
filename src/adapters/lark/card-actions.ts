import { spawnSync } from "node:child_process";
import type { CardActionEvent, LarkChannel } from "@larksuiteoapi/node-sdk";
import { orphanLabel } from "../../core/agents/takeover.js";
import {
  adoptOrphan,
  attachCommand,
  composeAdoptOutcome,
  findAdoptableOrphans,
} from "../../core/agents/takeover-service.js";
import { findProjectAutomationConflictForSession } from "../../core/automation/project-conflicts.js";
import { AUTOPILOT_ACTIONS } from "../../core/autopilot/action-registry.js";
import {
  cancelActiveDelegatedTask,
  cancelActiveDelegatedTaskByRunId,
  formatActiveDelegateCancel,
  formatActiveDelegateStart,
  listActiveDelegateQueue,
  parseDelegateRequirement,
  startActiveDelegatedTask,
} from "../../core/autopilot/delegated-task.js";
import { planMessageAction } from "../../core/command/action-plan.js";
import { performRestart, performStart } from "../../core/command/dispatch.js";
import type { HandlerDeps } from "../../core/deps.js";
import { isUiLang, messages, resolveUiLang, setUiLang } from "../../core/i18n/index.js";
import type { ForeignAction } from "../../core/infra/status-install.js";
import { OpportunityStore } from "../../core/opportunities/store.js";
import {
  formatOpportunityAgentDiscussionPrompt,
  formatOpportunityBatchAgentDiscussionPrompt,
} from "../../core/opportunities/view.js";
import {
  type BrowseAction,
  browseCwd,
  clearBrowse,
  displayPath,
  requestNewFolder,
  resolveBrowseAction,
} from "../../core/projects/dir-browser.js";
import { getBinding, isProjectGroup, unbindGroup } from "../../core/projects/group-bindings.js";
import { projectLabel } from "../../core/projects/project-label.js";
import { chatScope } from "../../core/projects/project-manager.js";
import {
  botSelfRepoWarning,
  createProjectFromPath,
  removeProjectBySession,
  resolveAliveSessionByShortId,
  switchToProject,
} from "../../core/projects/project-ops.js";
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
  isPromptTranslateInstallable,
} from "../../core/read/prompt-translation.js";
import { DEFAULT_INPUTS, lookupInput } from "../../core/read/recent-inputs.js";
import {
  checkVoiceSupport,
  installVoice,
  isVoiceInstallable,
  isVoicePlatformSupported,
  resolveWhisperLanguage,
  setWhisperLanguage,
  VOICE_LANGS,
} from "../../core/read/voice-support.js";
import { recoverProjects } from "../../core/recovery/recover.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { newTraceId, runWithLogContext } from "../../shared/utils/log-context.js";
import { createLogger } from "../../shared/utils/logger.js";
import { isOpenIdAllowed } from "./auth.js";
import { verifyValue } from "./card-signing.js";
import {
  actionConfirmationCard,
  adoptConfirmCard,
  adoptDoneCard,
  autopilotPlanCard,
  autopilotQueueCard,
  browseCard,
  helpCard,
  langCard,
  opportunityDetailCard,
  opportunityDigestCard,
  startPickerCard,
  voiceLangCard,
} from "./cards.js";
import { type ChatKind, checkAction, type ProjectAction, serviceableChat } from "./chat-policy.js";
import { enqueueLarkAction, resolveSession, runImmediateLarkAction } from "./executor.js";
import {
  bindCurrentGroupBySid,
  handleRestore,
  handleUnbind,
  makeBoundGroupBySid,
  makeExistingFreeGroupBySid,
  makeFreeGroupBySid,
} from "./group-commands.js";
import { sendPrompts } from "./prompts.js";
import { sendCard, sendError, sendText } from "./replies.js";
import { removeReplyTargetSession } from "./reply-target.js";
import {
  addRecentBySid,
  replyCreateProject,
  sendAliveList,
  sendBrowse,
  sendCurrentProject,
  sendDashboard,
  sendFreeGroupPicker,
  sendGroupBindPicker,
  sendGroupMenu,
  sendHistory,
  sendInputs,
  sendOrphanList,
  sendPeek,
  sendPromptTranslatePicker,
  sendQueueStatus,
  sendRecentList,
  sendRecoverPreview,
  sendStatusInstall,
} from "./views.js";

const log = createLogger("lark.card-actions");

type CardValue =
  | {
      cmd?: string;
      sid?: string;
      body?: string;
      title?: string;
      view?: boolean;
      lang?: string;
      arg?: string;
      idx?: number;
      pid?: number;
      chatId?: string;
      token?: string;
      action?: string;
      /** qcancel: the session + queued-message id to cancel. */
      s?: string;
      id?: string;
      ids?: string[];
      runId?: string;
      /** prompts: short-id for pget; tag short-id for pfilter/ppage; page number for ppage. */
      tagSid?: string;
      page?: number;
    }
  | undefined;

interface CardCtx {
  channel: LarkChannel;
  deps: HandlerDeps;
  evt: CardActionEvent;
  value: CardValue;
  /** The serviced chat kind, resolved once by the dispatcher's eligibility gate
   *  (the card callback carries no chat type). Drives the action policy. */
  chatKind: ChatKind;
}

type CardHandler = (ctx: CardCtx) => Promise<void>;

// --- Handlers that need more than a one-liner -------------------------------

async function handleVoiceLang({ channel, evt, value }: CardCtx): Promise<void> {
  if (!(value?.lang && VOICE_LANGS.some((l) => l.code === value.lang))) return;
  setWhisperLanguage("lark", value.lang);
  log.info(`voice recognition language set to ${value.lang} via card`);
  // Re-send the picker (regular card) with the ✅ moved. CardKit in-place updates
  // would need entity-card callbacks, which don't fire reliably on Feishu.
  await sendCard(channel, evt.chatId, voiceLangCard(value.lang));
}

/** Install the optional voice feature in-chat — the Feishu counterpart of
 *  Telegram's `/voice_install`. Shares the core install orchestration so the two
 *  surfaces can't drift. Allowed in any serviced chat (a host setup, not a
 *  project op). */
async function handleVoiceInstall({ channel, evt }: CardCtx): Promise<void> {
  const m = messages("lark");
  await runOptionalFeatureInstall({
    copy: {
      installing: m.voiceInstalling,
      ok: m.voiceInstallOk,
      alreadyReady: m.voiceAlreadyInstalled,
      inProgress: m.voiceInstalling,
      unsupported: m.voiceUnsupported,
      failed: m.voiceInstallFailed,
    },
    precheck: () => {
      if (checkVoiceSupport().ready) return { status: "already-ready" };
      if (!isVoicePlatformSupported()) return { status: "unsupported" };
      return null;
    },
    install: () => installVoice(),
    send: (notice) => sendText(channel, evt.chatId, notice.text),
    background: true,
    onResult: (result) => {
      if (result.status === "ok") {
        log.info("voice feature installed and enabled");
      } else if (result.status === "failed") {
        log.error("voice install failed", { data: { message: result.message } });
      }
    },
  });
}

async function handlePromptTranslateInstall({ channel, evt }: CardCtx): Promise<void> {
  const m = messages("lark");
  await runOptionalFeatureInstall({
    copy: {
      installing: m.promptTranslateInstalling,
      ok: m.promptTranslateInstallOk,
      alreadyReady: m.promptTranslateAlreadyInstalled,
      inProgress: m.promptTranslateInstalling,
      failed: m.promptTranslateInstallFailed,
    },
    install: () => installPromptTranslation(),
    send: (notice) => sendText(channel, evt.chatId, notice.text),
    background: true,
  });
}

async function handlePromptTranslate({ channel, evt, value }: CardCtx): Promise<void> {
  const arg = value?.arg?.trim() ?? "";
  if (!arg) {
    await sendPromptTranslatePicker(channel, evt.chatId);
    return;
  }
  const result = await applyPromptTranslateCommand("lark", arg);
  if (!result.ok) {
    await sendText(
      channel,
      evt.chatId,
      formatPromptTranslateCommandResult(result, messages("lark")),
    );
    return;
  }
  await sendPromptTranslatePicker(channel, evt.chatId);
}

async function handleUiLang({ channel, evt, value }: CardCtx): Promise<void> {
  const lang = value?.lang;
  if (!lang || !isUiLang(lang)) return;
  setUiLang("lark", lang);
  log.info(`ui language set to ${lang} via card`);
  await sendCard(channel, evt.chatId, langCard(lang));
}

/** True for a 1:1 chat. Resolved via the chat API (the card-action callback
 *  carries no chat type). Fail safe: an unresolved chat is treated as not-p2p
 *  so it gets ignored like an unbound group rather than serviced. */
async function isP2pChat(channel: LarkChannel, chatId: string): Promise<boolean> {
  try {
    return (await channel.getChatInfo(chatId)).chatType === "p2p";
  } catch (err) {
    log.warn("getChatInfo failed", { chatId, err });
    return false;
  }
}

/** Enforce the chat-type policy (chat-policy.ts) for a project/group action.
 *  Returns true when allowed; on refusal it surfaces the policy's message — a
 *  static refusal, or the "pinned, rebind instead" redirect for a group — and
 *  returns false. Single source: both surfaces consult ACTION_POLICY. */
async function gateAction(ctx: CardCtx, action: ProjectAction): Promise<boolean> {
  const verdict = checkAction(action, ctx.chatKind);
  if (verdict.ok) return true;
  if (verdict.deny.kind === "pinned") {
    const label = getBinding(ctx.evt.chatId)?.label ?? "";
    await sendText(ctx.channel, ctx.evt.chatId, messages("lark").groupPinnedNoSwitch(label));
  } else {
    await sendText(ctx.channel, ctx.evt.chatId, messages("lark")[verdict.deny.key]);
  }
  return false;
}

async function handleSwitch(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "switch"))) return;
  const session = await resolveAliveSessionByShortId(deps, value.sid);
  if (!session) return;
  await switchToProject(deps, chatScope("lark", evt.chatId), session);
  const path = getPathBySession(session) ?? undefined;
  const warn = botSelfRepoWarning(path, chatScope("lark", evt.chatId));
  await sendText(
    channel,
    evt.chatId,
    `${messages("lark").switchedTo(projectLabel(session, path))}${warn ? `\n\n${warn}` : ""}`,
  );
}

async function handleRemove(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  // Removing a project kills its project session — too destructive for a shared
  // group (it could be someone else's project); private chat only per policy.
  if (!(await gateAction(ctx, "remove"))) return;
  const session = await resolveAliveSessionByShortId(deps, value.sid);
  if (!session) return;
  await removeProjectBySession(deps, session);
  removeReplyTargetSession(session);
  await sendText(channel, evt.chatId, messages("lark").removed);
}

async function handleAddRecent(ctx: CardCtx): Promise<void> {
  if (!ctx.value?.sid) return;
  if (!(await gateAction(ctx, "addRecent"))) return;
  await addRecentBySid(ctx.channel, ctx.deps, ctx.evt.chatId, ctx.value.sid);
}

/** Create a bound group — private chat only per policy, mirroring `/newgroup`. */
async function handleMakeGroup(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "createGroup"))) return;
  await makeBoundGroupBySid(channel, deps, evt.chatId, value.sid, evt.operator.openId);
}

/** Re-run an input picked from /inputs: re-send the exact prompt to its session.
 * The text action's precondition gate handles a dead agent. */
/** ❌ on a "queued" ack: cancel that still-waiting message. On success the queue's
 * (cancel-aware) reject closure posts the plain confirmation; if it's already gone
 * (dispatched), confirm here anyway so the tap is never silent. */
async function handleQueueCancel({ channel, deps, evt, value }: CardCtx): Promise<void> {
  const m = messages("lark");
  const session = value?.s;
  const id = value?.id;
  if (!session || !id) return;
  // On success the queue's (cancel-aware) reject closure posts the 🗑 confirmation;
  // on FALSE the item is already gone (dispatched, or a deduped phantom), so say so
  // — never falsely confirm a cancellation that didn't happen.
  if (!deps.queue.cancelQueued(session, id, m.queueItemCancelled)) {
    await sendText(channel, evt.chatId, m.queueItemGone);
  }
}

async function handleInputRedo({ channel, evt, value }: CardCtx): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- eslint reads value as non-null here, but tsc types CardCtx.value as possibly-undefined, so the ?. is required to compile
  if (typeof value?.token !== "string" || typeof value?.idx !== "number") return;
  const found = lookupInput(value.token, value.idx);
  if (!found) {
    await sendText(channel, evt.chatId, messages("lark").inputsExpired);
    return;
  }
  // Don't auto-send — hand the verbatim prompt back as an editable draft so the user
  // can tweak it before sending. Raw `{ text }` (not sendText) skips the markdown +
  // tildeify pass, keeping the text EXACTLY as typed. Aligned with Telegram.
  await channel.send(evt.chatId, { text: found.prompt });
}

/** Escape hatch from the private-chat group overview: clear a binding by its chat
 * id (the group may be gone / left), so the project can be rebuilt. p2p only. */
async function handleUnbindGroup(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value, chatKind } = ctx;
  if (chatKind !== "p2p" || typeof value?.chatId !== "string") return;
  const ok = unbindGroup(value.chatId);
  await sendText(
    channel,
    evt.chatId,
    ok ? messages("lark").groupUnbound : messages("lark").groupNotBound,
  );
  await sendGroupMenu(channel, deps, evt.chatId); // refresh so the cleared group disappears
}

/** Create a parallel project group — private chat only, mirroring makegroup's gate. */
async function handleMakeFreeGroup(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "createGroup"))) return;
  await makeFreeGroupBySid(channel, deps, evt.chatId, value.sid, evt.operator.openId);
}

/** Create a group for an already-running independent session, reusing that session. */
async function handleMakeExistingFreeGroup(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "createGroup"))) return;
  await makeExistingFreeGroupBySid(channel, deps, evt.chatId, value.sid, evt.operator.openId);
}

/** Bind the current chat to a project — group only per policy, mirroring `/bind`. */
async function handleBindHere(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "bind"))) return;
  await bindCurrentGroupBySid(channel, deps, evt.chatId, value.sid);
}

async function pickAndLaunch(
  { channel, deps, evt, value, chatKind }: CardCtx,
  restart: boolean,
): Promise<void> {
  if (typeof value?.idx !== "number") return;
  const pick = deps.config.startCommands[value.idx];
  if (!pick) return;
  const session = await resolveSession(channel, deps, evt.chatId, undefined, chatKind === "p2p");
  if (!session) return;
  let msg: string;
  if (restart) {
    await performRestart(deps, session, pick.command);
    msg = messages("lark").agentStartedWith(pick.label);
  } else {
    const r = await performStart(deps, session, pick.command);
    msg =
      r === "already-running"
        ? messages("lark").agentAlreadyRunning
        : messages("lark").agentStartedWith(pick.label);
  }
  await sendText(channel, evt.chatId, msg);
}

async function handleStartPick(ctx: CardCtx): Promise<void> {
  await pickAndLaunch(ctx, false);
}

async function handleRestartPick(ctx: CardCtx): Promise<void> {
  await pickAndLaunch(ctx, true);
}

/** Tap a candidate → confirm card (interrupting + ending the original is
 * disruptive, so confirm first). Mirrors Telegram's adoptshow. */
async function handleAdoptShow({ channel, evt, value, chatKind }: CardCtx): Promise<void> {
  if (chatKind !== "p2p" || typeof value?.pid !== "number") return;
  const orphan = (await findAdoptableOrphans()).find((o) => o.pid === value.pid);
  if (!orphan) {
    await sendText(channel, evt.chatId, messages("lark").adoptGone);
    return;
  }
  await sendCard(channel, evt.chatId, adoptConfirmCard(orphan.pid, orphanLabel(orphan)));
}

/** Confirmed adopt: SIGINT→SIGTERM→resume via the shared service, then report. */
async function runAdoptExec(
  { channel, deps, evt, value, chatKind }: CardCtx,
  target: "path" | "free",
): Promise<void> {
  if (chatKind !== "p2p" || typeof value?.pid !== "number") return;
  // Acknowledge before the (multi-second) takeover so the user isn't left waiting
  // on a dead button — parity with the Telegram toast.
  await sendText(channel, evt.chatId, messages("lark").adoptWorking);
  const result = await adoptOrphan(
    value.pid,
    {
      bridge: deps.bridge,
      configResolver: deps.configResolver,
      projectSessionPrefix: deps.config.projectSessionPrefix,
      warmupMs: deps.config.sessionWarmupMs,
    },
    { target },
  );
  const outcome = composeAdoptOutcome(result, chatScope("lark", evt.chatId));
  if (!outcome.ok) {
    await sendText(channel, evt.chatId, outcome.body);
    return;
  }
  // Point this 1:1 chat at the adopted session (this handler is p2p-only above).
  await deps.currentProject.set(chatScope("lark", evt.chatId), outcome.sessionName);
  await sendCard(
    channel,
    evt.chatId,
    adoptDoneCard(outcome.body, sessionShortId(outcome.sessionName)),
  );
}

async function handleAdoptExec(ctx: CardCtx): Promise<void> {
  await runAdoptExec(ctx, "path");
}

async function handleAdoptFreeExec(ctx: CardCtx): Promise<void> {
  await runAdoptExec(ctx, "free");
}

/** Confirmed reboot recovery: recreate every gone session + relaunch its agent. */
async function handleRecoverExec({ channel, deps, evt, chatKind }: CardCtx): Promise<void> {
  if (chatKind !== "p2p") return;
  // Recovery recreates + relaunches N sessions (can take 10-30s); acknowledge first
  // so the user isn't staring at a silent chat — parity with the Telegram toast.
  await sendText(channel, evt.chatId, messages("lark").recoverWorking);
  const res = await recoverProjects(deps);
  await sendText(
    channel,
    evt.chatId,
    res.busy
      ? messages("lark").recoverBusy
      : messages("lark").recoverDone(
          res.launched.length,
          res.shellOnly.length,
          res.alreadyAlive.length,
          res.failed.length,
        ),
  );
}

/** "View on computer": show the attach command on demand. */
async function handleAdoptAttach({ channel, deps, evt, value }: CardCtx): Promise<void> {
  if (!value?.sid) return;
  const session = await resolveAliveSessionByShortId(deps, value.sid);
  if (!session) {
    await sendText(channel, evt.chatId, messages("lark").sessionGone);
    return;
  }
  await sendText(channel, evt.chatId, messages("lark").adoptAttachHint(attachCommand(session)));
}

/** Apply a usage-install foreign-statusLine choice (p2p only) and re-render. */
async function handleStatusInstallChoice(
  { channel, evt, chatKind }: CardCtx,
  action: ForeignAction,
): Promise<void> {
  if (chatKind !== "p2p") return;
  await sendStatusInstall(channel, evt.chatId, action);
}

/** Apply a directory-browser navigation tap and send the refreshed card. A fresh
 * (regular) card per tap — CardKit in-place updates would need entity-card
 * callbacks, which don't fire reliably in some Feishu setups. */
async function handleBrowseNav(
  { channel, deps, evt }: CardCtx,
  action: BrowseAction,
): Promise<void> {
  const view = resolveBrowseAction(
    chatScope("lark", evt.chatId),
    action,
    deps.config.cdAllowedDirs,
  );
  await sendCard(channel, evt.chatId, browseCard(view));
}

/** Create a project at the browser's current dir, then forget the nav state. */
async function handleBrowseCreate({ channel, deps, evt }: CardCtx): Promise<void> {
  const scope = chatScope("lark", evt.chatId);
  const cwd = browseCwd(scope);
  if (!cwd) return; // state expired
  clearBrowse(scope);
  await replyCreateProject(
    channel,
    deps,
    evt.chatId,
    await createProjectFromPath(deps, scope, cwd),
  );
}

/** Prompt for a new folder name (Feishu has no force-reply, so a plain prompt —
 * the next text message is taken as the name by the message handler). */
async function handleBrowseNewFolder({ channel, evt }: CardCtx): Promise<void> {
  const cwd = requestNewFolder(chatScope("lark", evt.chatId));
  if (!cwd) return; // not browsing a directory
  await sendText(channel, evt.chatId, messages("lark").browseNewFolderPrompt(displayPath(cwd)));
}

/** Cancel browsing: forget the state and acknowledge. */
async function handleBrowseCancel({ channel, evt }: CardCtx): Promise<void> {
  clearBrowse(chatScope("lark", evt.chatId));
  await sendText(channel, evt.chatId, messages("lark").browseCancelled);
}

const browseIdx = (ctx: CardCtx): number => ctx.value?.idx ?? 0;

// --- Supervisor delegation handlers ----------------------------------------

/** Resolve the session for a delegation card action. */
async function apSession(ctx: CardCtx): Promise<string | undefined> {
  const s = (ctx.value as { s?: string } | undefined)?.s;
  if (s) return s;
  const project = await ctx.deps.currentProject.get(chatScope("lark", ctx.evt.chatId));
  return project ?? undefined;
}

async function handleApDelegate(ctx: CardCtx): Promise<void> {
  const session = await apSession(ctx);
  if (!session) return;
  const requirement = parseDelegateRequirement("delegate");
  if (requirement === null) return;
  const result = await startActiveDelegatedTask(ctx.deps, { session, requirement });
  await sendText(ctx.channel, ctx.evt.chatId, formatActiveDelegateStart(result));
  if (result.status === "blocked" && result.showQueue) {
    await sendCard(ctx.channel, ctx.evt.chatId, autopilotQueueCard(listActiveDelegateQueue()));
  }
}

async function handleApPlan(ctx: CardCtx): Promise<void> {
  const session = await apSession(ctx);
  if (!session) return;
  await sendCard(ctx.channel, ctx.evt.chatId, autopilotPlanCard(session));
}

async function handleApCancelDelegate(ctx: CardCtx): Promise<void> {
  const session = await apSession(ctx);
  if (!session) return;
  const result = await cancelActiveDelegatedTask(ctx.deps, { session });
  await sendText(ctx.channel, ctx.evt.chatId, formatActiveDelegateCancel(result));
}

async function handleApQueue(ctx: CardCtx): Promise<void> {
  await sendCard(ctx.channel, ctx.evt.chatId, autopilotQueueCard(listActiveDelegateQueue()));
}

async function handleApCancelRun(ctx: CardCtx): Promise<void> {
  const runId = ctx.value?.runId;
  if (typeof runId !== "string" || runId.trim().length === 0) return;
  const result = await cancelActiveDelegatedTaskByRunId(ctx.deps, { runId: runId.trim() });
  await sendText(ctx.channel, ctx.evt.chatId, formatActiveDelegateCancel(result));
  await sendCard(ctx.channel, ctx.evt.chatId, autopilotQueueCard(listActiveDelegateQueue()));
}

function opportunityId(ctx: CardCtx): string | null {
  const id = ctx.value?.id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function opportunityIds(ctx: CardCtx): string[] {
  return Array.isArray(ctx.value?.ids)
    ? ctx.value.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
}

function loadOpportunities(ids: string[]): {
  suggestions: NonNullable<ReturnType<OpportunityStore["get"]>>[];
  missing: string[];
} {
  const store = new OpportunityStore();
  const suggestions: NonNullable<ReturnType<OpportunityStore["get"]>>[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const suggestion = store.get(id);
    if (suggestion === null) missing.push(id);
    else suggestions.push(suggestion);
  }
  return { suggestions, missing };
}

function opportunityNotificationRows(
  suggestions: NonNullable<ReturnType<OpportunityStore["get"]>>[],
) {
  return suggestions.map((suggestion) => ({
    id: suggestion.id,
    title: suggestion.title,
    projectName: suggestion.projectName,
    category: suggestion.category,
    confidence: suggestion.confidence,
    estimatedComplexity: suggestion.estimatedComplexity,
    status: suggestion.status,
    value: suggestion.value,
    problem: suggestion.problem,
    recommendedApproach: suggestion.recommendedApproach,
  }));
}

function opportunityDiscussionBlockReason(
  deps: HandlerDeps,
  session: string,
  projectPath: string,
): string | null {
  const m = messages("lark");
  const conflict = findProjectAutomationConflictForSession(session);
  if (conflict !== null) {
    return m.opportunityAutomationConflict(
      conflict.taskKind,
      conflict.runId,
      conflict.supervisorSession,
    );
  }

  if (
    deps.queue.isSessionProcessing(session) ||
    deps.queue.getCurrentSessionMessage(session) !== undefined ||
    deps.queue.getSessionQueue(session).length > 0
  ) {
    return m.opportunityQueueBusy;
  }

  const status = spawnSync("git", ["status", "--short"], {
    cwd: projectPath,
    encoding: "utf8",
  });
  if (status.status !== 0) {
    const reason = [status.stderr, status.stdout].filter(Boolean).join("\n").trim();
    return m.opportunityGitStatusUnknown(reason || "git status --short failed");
  }
  const dirty = status.stdout.trim();
  if (dirty.length > 0) {
    const preview = dirty.split(/\r?\n/).slice(0, 12).join("\n");
    return m.opportunityDirtyWorktree(preview);
  }
  return null;
}

async function handleOpportunityShow(ctx: CardCtx): Promise<void> {
  const id = opportunityId(ctx);
  if (id === null) return;
  const suggestion = new OpportunityStore().get(id);
  if (suggestion === null) {
    await sendText(ctx.channel, ctx.evt.chatId, messages("lark").opportunityNotFound(id));
    return;
  }
  await sendCard(
    ctx.channel,
    ctx.evt.chatId,
    opportunityDetailCard(suggestion, {
      allowDelegate: true,
      title: `Opportunity: ${suggestion.title}`,
    }),
  );
}

async function handleOpportunityDiscuss(ctx: CardCtx): Promise<void> {
  const id = opportunityId(ctx);
  if (id === null) return;
  const store = new OpportunityStore();
  const suggestion = store.get(id);
  if (suggestion === null) {
    await sendText(ctx.channel, ctx.evt.chatId, messages("lark").opportunityNotFound(id));
    return;
  }
  const opened = await createProjectFromPath(
    ctx.deps,
    chatScope("lark", ctx.evt.chatId),
    suggestion.projectPath,
  );
  if (opened.status !== "created" && opened.status !== "switched") {
    const reason =
      opened.status === "invalid" ? `${opened.error}: ${opened.resolvedPath}` : opened.message;
    await sendText(
      ctx.channel,
      ctx.evt.chatId,
      messages("lark").opportunityCannotOpenProject(reason),
    );
    return;
  }
  const blocked = opportunityDiscussionBlockReason(
    ctx.deps,
    opened.sessionName,
    opened.projectPath,
  );
  if (blocked !== null) {
    await sendText(ctx.channel, ctx.evt.chatId, blocked);
    return;
  }
  store.updateStatus(id, "discussing");
  await sendCard(
    ctx.channel,
    ctx.evt.chatId,
    opportunityDetailCard(
      { ...suggestion, status: "discussing" },
      {
        allowDelegate: true,
        title: `Discussing: ${suggestion.title}`,
      },
    ),
  );
  await enqueueLarkAction(
    ctx.channel,
    ctx.deps,
    ctx.evt.chatId,
    ctx.evt.messageId,
    "text",
    formatOpportunityAgentDiscussionPrompt(suggestion),
    opened.sessionName,
    ctx.chatKind === "p2p",
  );
}

async function handleOpportunityDismiss(ctx: CardCtx): Promise<void> {
  const id = opportunityId(ctx);
  if (id === null) return;
  const updated = new OpportunityStore().updateStatus(id, "dismissed");
  await sendText(
    ctx.channel,
    ctx.evt.chatId,
    updated === null
      ? messages("lark").opportunityNotFound(id)
      : messages("lark").opportunitySkipped(1),
  );
}

async function handleOpportunityDiscussAll(ctx: CardCtx): Promise<void> {
  const ids = opportunityIds(ctx);
  if (ids.length === 0) return;
  const { suggestions, missing } = loadOpportunities(ids);
  if (missing.length > 0 || suggestions.length === 0) {
    await sendText(
      ctx.channel,
      ctx.evt.chatId,
      messages("lark").opportunityNotFound(missing.join(", ")),
    );
    return;
  }
  const first = suggestions[0];
  if (first === undefined) return;
  if (suggestions.some((suggestion) => suggestion.projectPath !== first.projectPath)) {
    await sendText(ctx.channel, ctx.evt.chatId, messages("lark").opportunityMixedProjects);
    return;
  }
  const opened = await createProjectFromPath(
    ctx.deps,
    chatScope("lark", ctx.evt.chatId),
    first.projectPath,
  );
  if (opened.status !== "created" && opened.status !== "switched") {
    const reason =
      opened.status === "invalid" ? `${opened.error}: ${opened.resolvedPath}` : opened.message;
    await sendText(
      ctx.channel,
      ctx.evt.chatId,
      messages("lark").opportunityCannotOpenProject(reason),
    );
    return;
  }
  const blocked = opportunityDiscussionBlockReason(
    ctx.deps,
    opened.sessionName,
    opened.projectPath,
  );
  if (blocked !== null) {
    await sendText(ctx.channel, ctx.evt.chatId, blocked);
    return;
  }
  const store = new OpportunityStore();
  for (const suggestion of suggestions) store.updateStatus(suggestion.id, "discussing");
  const discussing = suggestions.map((suggestion) => ({
    ...suggestion,
    status: "discussing" as const,
  }));
  await sendCard(
    ctx.channel,
    ctx.evt.chatId,
    opportunityDigestCard({
      title: `Discussing opportunities: ${first.projectName}`,
      body: `Project: ${first.projectName}\nSuggestions: ${suggestions.length}\nDiscuss these together before implementation.`,
      opportunities: opportunityNotificationRows(discussing),
      allowDelegate: true,
    }),
  );
  await enqueueLarkAction(
    ctx.channel,
    ctx.deps,
    ctx.evt.chatId,
    ctx.evt.messageId,
    "text",
    formatOpportunityBatchAgentDiscussionPrompt(suggestions),
    opened.sessionName,
    ctx.chatKind === "p2p",
  );
}

async function handleOpportunityDismissAll(ctx: CardCtx): Promise<void> {
  const ids = opportunityIds(ctx);
  if (ids.length === 0) return;
  const store = new OpportunityStore();
  let skipped = 0;
  const missing: string[] = [];
  for (const id of ids) {
    if (store.updateStatus(id, "dismissed") === null) missing.push(id);
    else skipped++;
  }
  await sendText(
    ctx.channel,
    ctx.evt.chatId,
    missing.length > 0
      ? messages("lark").opportunitySkippedMissing(skipped, missing.join(", "))
      : messages("lark").opportunitySkipped(skipped),
  );
}

/**
 * Button `cmd` → handler. Each returns after doing its work; commands not here
 * fall through to the immediate/queued action routing (and finally a no-op for
 * unknown cmds). `start` is deliberately absent — it needs the picker-vs-fall-
 * through decision made in the dispatcher below.
 */
const CARD_HANDLERS: Record<string, CardHandler> = {
  help: async ({ channel, evt }) => {
    await sendCard(
      channel,
      evt.chatId,
      helpCard(isProjectGroup(evt.chatId), isVoiceInstallable(), isPromptTranslateInstallable()),
    );
  },
  noop: async () => {},
  peek: ({ channel, deps, evt }) => sendPeek(channel, deps, evt.chatId),
  history: ({ channel, deps, evt }) => sendHistory(channel, deps, evt.chatId, 0),
  inputs: ({ channel, deps, evt }) => sendInputs(channel, deps, evt.chatId, DEFAULT_INPUTS),
  listalive: ({ channel, deps, evt }) => sendAliveList(channel, deps, evt.chatId),
  recent: ({ channel, deps, evt }) => sendRecentList(channel, deps, evt.chatId),
  current: ({ channel, deps, evt }) => sendCurrentProject(channel, deps, evt.chatId),
  queuestatus: ({ channel, deps, evt }) => sendQueueStatus(channel, deps, evt.chatId),
  // Host-wide overview — restrict to 1:1 chats (mirrors the /dashboard slash gate;
  // the button is only rendered on non-group cards too).
  dashboard: ({ channel, deps, evt, chatKind }) =>
    chatKind === "p2p" ? sendDashboard(channel, deps, evt.chatId) : Promise.resolve(),
  // Voice recognition-language picker (mirrors Telegram /voice_lang).
  voicelangmenu: async ({ channel, evt }) => {
    await sendCard(channel, evt.chatId, voiceLangCard(resolveWhisperLanguage("lark")));
  },
  voicelang: handleVoiceLang,
  voiceinstall: handleVoiceInstall,
  prompttranslate: handlePromptTranslate,
  translateinstall: handlePromptTranslateInstall,
  // UI-language picker (/lang).
  uilangmenu: async ({ channel, evt }) => {
    await sendCard(channel, evt.chatId, langCard(resolveUiLang("lark")));
  },
  uilang: handleUiLang,
  switch: handleSwitch,
  remove: handleRemove,
  addrecent: handleAddRecent,
  // --- Usage-reporting install (mirrors Telegram /status_install) ---
  statusinstall: ({ channel, evt, chatKind }) =>
    chatKind === "p2p" ? sendStatusInstall(channel, evt.chatId) : Promise.resolve(),
  statusoverwrite: (ctx) => handleStatusInstallChoice(ctx, "overwrite"),
  statuswrap: (ctx) => handleStatusInstallChoice(ctx, "wrap"),
  statussnippet: (ctx) => handleStatusInstallChoice(ctx, "snippet"),
  statusskip: (ctx) => handleStatusInstallChoice(ctx, "skip"),
  // --- Directory browser (mirrors Telegram /add_project no-arg) ---
  browseopen: (ctx) => handleBrowseNav(ctx, { kind: "open", index: browseIdx(ctx) }),
  browseroot: (ctx) => handleBrowseNav(ctx, { kind: "root", index: browseIdx(ctx) }),
  browseup: (ctx) => handleBrowseNav(ctx, { kind: "up" }),
  browsepage: (ctx) => handleBrowseNav(ctx, { kind: "page", page: browseIdx(ctx) }),
  // Open the directory browser from the help-card button (Feishu has no slash menu),
  // mirroring the typed `/add_project` no-arg flow.
  addproject: ({ channel, deps, evt }) => sendBrowse(channel, deps, evt.chatId),
  browsecreate: handleBrowseCreate,
  browsenewfolder: handleBrowseNewFolder,
  browsecancel: handleBrowseCancel,
  // --- Adopt an unmanaged claude (mirrors Telegram /adopt) ---
  adoptlist: ({ channel, evt, chatKind }) =>
    chatKind === "p2p" ? sendOrphanList(channel, evt.chatId) : Promise.resolve(),
  adopt: handleAdoptShow,
  adoptgo: handleAdoptExec,
  adoptfree: handleAdoptFreeExec,
  adoptcancel: async ({ channel, evt }) => {
    await sendText(channel, evt.chatId, messages("lark").adoptCancelled);
  },
  adoptattach: handleAdoptAttach,
  // --- Reboot recovery (mirrors Telegram /recover) ---
  recover: ({ channel, deps, evt, chatKind }) =>
    chatKind === "p2p" ? sendRecoverPreview(channel, deps, evt.chatId) : Promise.resolve(),
  recovergo: handleRecoverExec,
  recovercancel: async ({ channel, evt }) => {
    await sendText(channel, evt.chatId, messages("lark").recoverCancelled);
  },
  // --- Project-group buttons (no typing needed) ---
  groupmenu: ({ channel, deps, evt }) => sendGroupMenu(channel, deps, evt.chatId),
  freegroupmenu: ({ channel, deps, evt }) => sendFreeGroupPicker(channel, deps, evt.chatId),
  makegroup: handleMakeGroup,
  makefreegroup: handleMakeFreeGroup,
  makefreeprojectgroup: handleMakeExistingFreeGroup,
  bindhere: handleBindHere,
  rebind: ({ channel, deps, evt }) => sendGroupBindPicker(channel, deps, evt.chatId),
  unbind: ({ channel, deps, evt, chatKind }) => handleUnbind(channel, deps, evt.chatId, chatKind),
  unbindgroup: handleUnbindGroup,
  restore: ({ channel, deps, evt }) => handleRestore(channel, deps, evt.chatId),
  startpick: handleStartPick,
  restartpick: handleRestartPick,
  inputredo: handleInputRedo,
  qcancel: handleQueueCancel,
  // --- Supervisor delegation ---
  [AUTOPILOT_ACTIONS.delegate.larkCmd]: handleApDelegate,
  [AUTOPILOT_ACTIONS["review-plan"].larkCmd]: handleApPlan,
  [AUTOPILOT_ACTIONS["confirm-delegate"].larkCmd]: handleApDelegate,
  [AUTOPILOT_ACTIONS["cancel-delegate"].larkCmd]: handleApCancelDelegate,
  ap_queue: handleApQueue,
  ap_cancel_run: handleApCancelRun,
  // --- Opportunity discovery proposal cards ---
  oppshow: handleOpportunityShow,
  oppdiscuss: handleOpportunityDiscuss,
  oppdismiss: handleOpportunityDismiss,
  oppdiscussall: handleOpportunityDiscussAll,
  oppdismissall: handleOpportunityDismissAll,
  // --- Prompt library (mirrors Telegram pp/pf/pn callbacks) ---
  pget: async ({ channel, deps, evt, value, chatKind }) => {
    if (chatKind !== "p2p") return;
    const lib = makePromptLib(deps.config);
    if (!lib.isEnabled()) {
      await sendText(channel, evt.chatId, messages("lark").promptsDisabled);
      return;
    }
    try {
      const name = await resolvePromptByShortId(lib, String(value?.sid ?? ""));
      if (!name) {
        await sendText(channel, evt.chatId, messages("lark").promptsGone);
        return;
      }
      const body = await lib.get(name);
      await sendText(channel, evt.chatId, `\`\`\`\n${body}\n\`\`\``);
    } catch (err) {
      log.warn("prompt card action failed", { err, data: { cmd: "pget" } });
      await sendText(channel, evt.chatId, messages("lark").promptsError);
    }
  },
  pfilter: async ({ channel, deps, evt, value, chatKind }) => {
    if (chatKind !== "p2p") return;
    const lib = makePromptLib(deps.config);
    if (!lib.isEnabled()) {
      await sendText(channel, evt.chatId, messages("lark").promptsDisabled);
      return;
    }
    try {
      const tags = await lib.listTags();
      const tag = (await resolveTagByShortId(lib, String(value?.tagSid ?? ""), tags)) ?? "";
      await sendPrompts(channel, deps, evt.chatId, undefined, 0, tag, tags);
    } catch (err) {
      log.warn("prompt card action failed", { err, data: { cmd: "pfilter" } });
      await sendText(channel, evt.chatId, messages("lark").promptsError);
    }
  },
  ppage: async ({ channel, deps, evt, value, chatKind }) => {
    if (chatKind !== "p2p") return;
    const lib = makePromptLib(deps.config);
    if (!lib.isEnabled()) {
      await sendText(channel, evt.chatId, messages("lark").promptsDisabled);
      return;
    }
    try {
      const tags = await lib.listTags();
      const tagSid = String(value?.tagSid ?? "");
      const tag = tagSid ? ((await resolveTagByShortId(lib, tagSid, tags)) ?? "") : "";
      await sendPrompts(channel, deps, evt.chatId, undefined, Number(value?.page ?? 0), tag, tags);
    } catch (err) {
      log.warn("prompt card action failed", { err, data: { cmd: "ppage" } });
      await sendText(channel, evt.chatId, messages("lark").promptsError);
    }
  },
};

/**
 * Build the channel `cardAction` handler. Button clicks carry a
 * `{ cmd }` value that maps onto the same immediate/queued routing as
 * text commands. Unknown senders are dropped silently.
 */
export function makeCardActionHandler(channel: LarkChannel, deps: HandlerDeps) {
  const allowed = deps.config.lark?.allowedOpenIds ?? new Set<string>();

  return async (evt: CardActionEvent): Promise<void> =>
    runWithLogContext({ traceId: newTraceId(), channel: "lark", chatId: evt.chatId }, async () => {
      if (!isOpenIdAllowed(evt.operator.openId, allowed)) {
        log.info(`drop cardAction from open_id=${evt.operator.openId || "?"}`);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- raw SDK ingest: a malformed event may lack action despite the type; degrade to a clean drop, not a throw
      const rawValue = evt.action?.value;
      if (!verifyValue(rawValue)) {
        log.warn(`drop cardAction: invalid signature chat=${evt.chatId}`);
        return;
      }

      const value = rawValue as CardValue;
      const cmd = value?.cmd;
      if (!cmd) return;

      log.info(`cardAction cmd=${cmd} chat=${evt.chatId}`);

      try {
        // Mirror the text handler (handlers.ts): only 1:1 chats and bound project
        // groups are serviced (serviceableChat). An unbound group — including one
        // whose binding was lost — is ignored, so its (possibly stale) buttons do
        // nothing. Bound is a cheap local check; only hit the chat API otherwise.
        // Resolve the chat kind ONCE here and thread it into the handlers so the
        // per-action policy (chat-policy.ts) is enforced symmetrically with text.
        const isP2p = isProjectGroup(evt.chatId) ? false : await isP2pChat(channel, evt.chatId);
        if (!serviceableChat(isP2p, evt.chatId)) {
          log.info(`ignore cardAction in unbound chat=${evt.chatId} cmd=${cmd}`);
          return;
        }
        const chatKind: ChatKind = isP2p ? "p2p" : "group";

        if (cmd === "noop") return;

        const handler = CARD_HANDLERS[cmd];
        if (handler) {
          await handler({ channel, deps, evt, value, chatKind });
          return;
        }

        const planned = await planMessageAction({
          deps,
          action: cmd === "confirm" ? String(value.action ?? "") : cmd,
          confirmed: cmd === "confirm",
          session:
            cmd === "confirm" || cmd === "start" || cmd === "restart"
              ? await resolveSession(channel, deps, evt.chatId, undefined, isP2p)
              : undefined,
          text: cmd,
          allowStartPickerWithoutSession: true,
        });

        if (planned.kind === "confirm") {
          const session = await resolveSession(channel, deps, evt.chatId, undefined, isP2p);
          if (!session) return;
          await sendCard(
            channel,
            evt.chatId,
            actionConfirmationCard(planned.action, session, !isP2p),
          );
          return;
        }

        if (planned.kind === "already-running") {
          await sendText(channel, evt.chatId, messages("lark").agentAlreadyRunning);
          return;
        }

        if (planned.kind === "pick-start-command") {
          await sendCard(
            channel,
            evt.chatId,
            startPickerCard(deps.config.startCommands, planned.action),
          );
          return;
        }

        if (planned.kind === "no-session") return;

        if (planned.kind === "immediate") {
          await runImmediateLarkAction(
            channel,
            deps,
            evt.chatId,
            evt.messageId,
            planned.action,
            undefined,
            isP2p,
          );
          return;
        }

        if (planned.kind === "queued") {
          await enqueueLarkAction(
            channel,
            deps,
            evt.chatId,
            evt.messageId,
            planned.action,
            planned.text,
            undefined,
            isP2p,
          );
          return;
        }

        log.info(`unknown cardAction cmd=${cmd}`);
      } catch (err) {
        log.warn("cardAction failed", { err, data: { cmd } });
        await sendError(channel, evt.chatId, err);
      }
    });
}
