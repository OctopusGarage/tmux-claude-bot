import type { Context } from "grammy";
import { performStart } from "../../core/command/dispatch.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { openRecentProjectBySid } from "../../core/projects/project-ops.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { buildStartPickerKeyboard } from "./keyboards.js";
import { MSG } from "./messages.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { tgScope } from "./scope.js";

/**
 * Right after a fresh project session is created: with multiple configured launch
 * commands, show the flavor picker; with a single one, start it directly (so a
 * new project lands you in a running Claude without a second step).
 */
export async function startOrPickAfterCreate(
  deps: HandlerDeps,
  ctx: Context,
  session: string,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const tm = messages("telegram");
  if (deps.config.startCommands.length > 1) {
    await reply(ctx, "info", tm.startPickerPrompt, {
      session,
      replyMarkup: buildStartPickerKeyboard(deps.config.startCommands, sessionShortId(session)),
      replyTarget,
    });
    return;
  }
  const only = deps.config.startCommands[0];
  await performStart(deps, session, only?.command);
  await reply(ctx, "ok", tm.agentStartedWith(only?.label ?? "claude"), { session, replyTarget });
}

/**
 * Telegram-specific project lifecycle. The protocol-agnostic helpers live in
 * `core/project-ops.js` and are re-exported here so existing telegram importers
 * keep working; this file only keeps the entry point that needs ctx/reply.
 */

export {
  aliveProjectButtons,
  botSelfRepoWarning,
  recentProjectButtons,
  removeProjectBySession,
  resolveAliveSessionByShortId,
  switchToProject,
} from "../../core/projects/project-ops.js";

/**
 * Switch to a recent project by its short id, creating the project session (and
 * cd-ing into the directory) if it isn't running yet. Shared by the
 * `/add_project_<id>` command and the recent-list "add" button.
 */
export async function addRecentProjectBySid(
  deps: HandlerDeps,
  ctx: Context,
  sid: string,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const tm = messages("telegram");
  const r = await openRecentProjectBySid(deps, tgScope(ctx), sid);
  switch (r.status) {
    case "not-found":
      await reply(ctx, "err", MSG.noShortId(sid), { replyTarget });
      return;
    case "switched":
      await reply(ctx, "ok", tm.switched, { session: r.sessionName, replyTarget });
      return;
    case "not-allowed":
      await reply(ctx, "err", MSG.pathNotAllowed(deps.config.cdAllowedDirs), { replyTarget });
      return;
    case "created":
      await reply(ctx, "ok", tm.projectCreated, {
        session: r.sessionName,
        body: r.projectPath,
        replyTarget,
      });
      await startOrPickAfterCreate(deps, ctx, r.sessionName, replyTarget);
      return;
    case "error":
      await reply(ctx, "err", r.message, { replyTarget });
      return;
  }
}
