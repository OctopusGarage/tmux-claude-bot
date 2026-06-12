import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { openRecentProjectBySid } from "../../core/project-ops.js";
import { MSG } from "./messages.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { tgScope } from "./scope.js";

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
} from "../../core/project-ops.js";

/**
 * Switch to a recent project by its short id, creating the tmux session (and
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
      return;
    case "error":
      await reply(ctx, "err", r.message, { replyTarget });
      return;
  }
}
