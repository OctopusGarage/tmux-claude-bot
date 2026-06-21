import type { Context } from "grammy";
import { resolveAgentKind } from "../../core/agents/agentKindMap.js";
import { profileFor } from "../../core/agents/registry.js";
import { buildQueueStatusLines } from "../../core/command/queue-status.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import type { ForeignAction } from "../../core/infra/status-install.js";
import { runStatusInstall } from "../../core/infra/status-install.js";
import type { BrowseView } from "../../core/projects/dir-browser.js";
import type { CreateProjectResult } from "../../core/projects/project-ops.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import { getRecentInputs, storeInputList } from "../../core/read/recent-inputs.js";
import { formatSingleConversation } from "../../core/read/transcript.js";
import { planRecovery } from "../../core/recovery/recover.js";
import {
  actionableCount,
  aliveCount,
  recoverPreviewList,
} from "../../core/recovery/recover-view.js";
import { DEFAULT_PEEK_LINES, renderPeekPaneChunks } from "../../core/session/output.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import {
  buildBrowseKeyboard,
  buildControlKeyboard,
  buildInputsKeyboard,
  buildNewFreeKeyboard,
  buildProjectKeyboard,
  buildRecoverConfirmKeyboard,
  buildStatusInstallChoiceKeyboard,
} from "./keyboards.js";
import { MSG } from "./messages.js";
import { aliveProjectButtons, startOrPickAfterCreate } from "./project-ops.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { tgScope } from "./scope.js";

/**
 * Read-side renderers: fetch state (tmux pane, conversation history, queue) and
 * render it into a Telegram reply. No mutation — these only display. Kept apart
 * from command/callback wiring so the "what the user sees" lives in one place.
 */

/** Reboot-recovery preview: list the projects that would be recreated + relaunched,
 * with a confirm button. Shared by the /recover command and the panel button. */
export async function sendRecoverPreview(
  ctx: Context,
  deps: HandlerDeps,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  try {
    const plan = await planRecovery(deps);
    const n = actionableCount(plan);
    if (n === 0) {
      // Nothing to recover: either nothing is tracked, or everything tracked is
      // already running (show the roster so it's clear tracking works).
      const msg =
        plan.length === 0
          ? messages("telegram").recoverEmpty
          : messages("telegram").recoverAllRunning(plan.length, recoverPreviewList(plan));
      await reply(ctx, "info", msg, { replyTarget });
      return;
    }
    await reply(
      ctx,
      "info",
      messages("telegram").recoverPreview(n, aliveCount(plan), recoverPreviewList(plan)),
      { replyMarkup: buildRecoverConfirmKeyboard(), replyTarget },
    );
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
  }
}

/** The alive-projects list (tappable switch/delete keyboard, no body text). */
export async function sendAliveList(ctx: Context, deps: HandlerDeps): Promise<void> {
  try {
    const buttons = await aliveProjectButtons(deps, tgScope(ctx));
    if (buttons.length === 0) {
      await reply(ctx, "list", messages("telegram").aliveListEmpty, {
        replyMarkup: buildNewFreeKeyboard(),
      });
      return;
    }
    await reply(ctx, "list", messages("telegram").aliveListTitle(buttons.length), {
      replyMarkup: buildProjectKeyboard(buttons),
    });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`);
  }
}

/** Capture and send the tmux pane. `lines` (from `/peek N`) captures that many
 * lines of scrollback and pages the result across messages so tall output isn't
 * truncated to one screen; the control keyboard rides the LAST (bottom) message. */
export async function sendPeek(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  replyTarget: ReplyTargetMap,
  lines: number = DEFAULT_PEEK_LINES,
): Promise<void> {
  // Adapt the panel to liveness: a peek of an idle session shouldn't offer dead
  // control keys, just start/projects.
  const keyboard = buildControlKeyboard(
    sessionShortId(session),
    await deps.agent.checkIfRunning(session),
  );
  try {
    const snapshot = await deps.bridge.capturePaneColored(session, lines);
    const chunks = renderPeekPaneChunks(snapshot, deps.output, lines, deps.config.maxMessageLength);
    if (chunks.length === 0) {
      await reply(ctx, "view", messages("telegram").emptyPane, {
        session,
        replyMarkup: keyboard,
        replyTarget,
      });
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      await reply(ctx, "view", chunks.length > 1 ? `${i + 1}/${chunks.length}` : "", {
        session,
        body: chunks[i],
        code: true,
        replyMarkup: last ? keyboard : undefined,
        replyTarget,
      });
    }
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { session, replyTarget });
  }
}

/** Run the usage-reporting install and reply with the result, attaching the
 * foreign-statusLine choice buttons when a choice is pending. Mirrors Lark's
 * sendStatusInstall so both adapters share the run + render decision. */
export async function sendStatusInstall(
  ctx: Context,
  action: ForeignAction,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  try {
    const res = await runStatusInstall("telegram", action);
    await reply(ctx, "info", res.lines.join("\n"), {
      replyTarget,
      ...(res.foreignPending ? { replyMarkup: buildStatusInstallChoiceKeyboard() } : {}),
    });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
  }
}

/** The directory-browser message body: heading + breadcrumb, plus an empty/
 * unreadable note. Shared by the initial send and the in-place navigation edit. */
export function browseText(view: BrowseView): string {
  const m = messages("telegram");
  if (view.kind === "roots") return m.browseRootsTitle;
  const lines = [m.browseTitle, view.displayPath];
  if (view.error === "unreadable") lines.push(m.browseUnreadable);
  else if (view.entries.length === 0) lines.push(m.browseEmpty);
  return lines.join("\n");
}

/** Send the initial directory-browser message (plain text so the in-place
 * `editMessageText` updates render identically). */
export async function sendBrowse(ctx: Context, view: BrowseView): Promise<void> {
  await ctx.reply(browseText(view), { reply_markup: buildBrowseKeyboard(view) });
}

/** Map a `createProjectFromPath` outcome to a Telegram reply — shared by the
 * typed `/add_project <path>` and the directory-browser "create here" button. */
export async function replyCreateProject(
  ctx: Context,
  deps: HandlerDeps,
  result: CreateProjectResult,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const m = messages("telegram");
  switch (result.status) {
    case "invalid":
      if (result.error === "not-a-directory")
        await reply(ctx, "err", m.notADir(result.resolvedPath), { replyTarget });
      else if (result.error === "not-found")
        await reply(ctx, "err", m.dirNotExist(result.resolvedPath), { replyTarget });
      else await reply(ctx, "err", MSG.pathNotAllowed(deps.config.cdAllowedDirs), { replyTarget });
      return;
    case "switched":
      await reply(ctx, "warn", m.alreadySwitched, { session: result.sessionName, replyTarget });
      return;
    case "created":
      await reply(ctx, "ok", m.projectCreated, {
        session: result.sessionName,
        body: result.projectPath,
        replyTarget,
      });
      await startOrPickAfterCreate(deps, ctx, result.sessionName, replyTarget);
      return;
    case "error":
      await reply(ctx, "err", result.message, { replyTarget });
      return;
  }
}

/** Send the Nth-most-recent conversation round for a session (0 = latest). */
export async function sendHistory(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  index: number,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  try {
    const projectPath = getPathBySession(session);
    if (!projectPath) {
      await reply(ctx, "warn", messages("telegram").noPathMapping, {
        session,
        replyTarget,
      });
      return;
    }
    const profile = profileFor(await resolveAgentKind(deps.configResolver, session));
    const rounds = await profile.getRecentConversations(deps.configResolver, session, projectPath);
    if (rounds.length === 0) {
      await reply(ctx, "info", messages("telegram").noHistory, { session, replyTarget });
      return;
    }
    if (index >= rounds.length) {
      await reply(ctx, "warn", messages("telegram").onlyNRounds(rounds.length), {
        session,
        replyTarget,
      });
      return;
    }
    const round = rounds[index];
    if (round === undefined) return;
    const body = formatSingleConversation(round, index, rounds.length, "telegram");
    await reply(ctx, "view", messages("telegram").historyTitleShort, {
      session,
      body,
      markdown: true,
      replyMarkup: buildControlKeyboard(
        sessionShortId(session),
        await deps.agent.checkIfRunning(session),
      ),
      replyTarget,
    });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { session, replyTarget });
  }
}

/** `/inputs [N]`: list the last N inputs you sent (tap one to fetch & edit it). */
export async function sendInputs(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  replyTarget: ReplyTargetMap,
  limit: number,
): Promise<void> {
  try {
    const projectPath = getPathBySession(session);
    if (!projectPath) {
      await reply(ctx, "err", messages("telegram").noPathMapping, { session, replyTarget });
      return;
    }
    const inputs = await getRecentInputs(deps, session, projectPath, limit);
    if (inputs.length === 0) {
      await reply(ctx, "info", messages("telegram").inputsEmpty, { session, replyTarget });
      return;
    }
    const token = storeInputList(session, inputs);
    await reply(ctx, "view", messages("telegram").inputsTitle, {
      session,
      replyMarkup: buildInputsKeyboard(inputs, token),
      replyTarget,
    });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { session, replyTarget });
  }
}

/** Build and send the message-queue status across global and session queues. */
export async function sendQueueStatus(ctx: Context, deps: HandlerDeps): Promise<void> {
  const body = buildQueueStatusLines(deps, "telegram").join("\n");
  await reply(ctx, "queue", messages("telegram").queueTitle, { body });
}
