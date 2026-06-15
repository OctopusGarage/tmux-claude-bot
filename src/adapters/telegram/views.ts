import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import type { BrowseView } from "../../core/dir-browser.js";
import { formatSingleConversation, getRecentConversations } from "../../core/history.js";
import { messages } from "../../core/i18n/index.js";
import { markSemantics } from "../../core/output.js";
import type { CreateProjectResult } from "../../core/project-ops.js";
import { buildQueueStatusLines } from "../../core/queue-status.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import type { ForeignAction } from "../../core/status-install.js";
import { runStatusInstall } from "../../core/status-install.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import {
  buildBrowseKeyboard,
  buildControlKeyboard,
  buildNewFreeKeyboard,
  buildProjectKeyboard,
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

/** Capture and send the current tmux pane for a session. */
export async function sendPeek(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const keyboard = buildControlKeyboard(sessionShortId(session));
  try {
    const snapshot = await deps.bridge.capturePane(session);
    const processed = markSemantics(deps.output.process(snapshot));
    if (processed) {
      await reply(ctx, "view", "", {
        session,
        body: processed,
        code: true,
        replyMarkup: keyboard,
        replyTarget,
      });
    } else {
      await reply(ctx, "view", messages("telegram").emptyPane, {
        session,
        replyMarkup: keyboard,
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
    const configRoot = await deps.configResolver.resolveConfigRoot(session);
    const rounds = await getRecentConversations(projectPath, configRoot);
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
      replyMarkup: buildControlKeyboard(sessionShortId(session)),
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
