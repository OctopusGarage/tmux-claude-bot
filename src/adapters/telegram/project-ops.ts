import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { readRecentProjectLines } from "../../core/recentProjects.js";
import { isCdAllowed, sessionNameFromPath } from "../../core/sessionPathMap.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { MSG } from "./messages.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";

/**
 * Telegram-specific project lifecycle. The protocol-agnostic helpers live in
 * `core/project-ops.js` and are re-exported here so existing telegram importers
 * keep working; this file only keeps the entry point that needs ctx/reply.
 */

import { createProjectSession } from "../../core/project-ops.js";

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
  const prefix = deps.config.projectSessionPrefix;
  const lines = await readRecentProjectLines();
  const projectPath = lines.find((p) => sessionShortId(sessionNameFromPath(p, prefix)) === sid);
  if (!projectPath) {
    await reply(ctx, "err", MSG.noShortId(sid), { replyTarget });
    return;
  }
  const sessionName = sessionNameFromPath(projectPath, prefix);
  try {
    if (await deps.bridge.hasSession(sessionName)) {
      await deps.currentProject.set("telegram", sessionName);
      await reply(ctx, "ok", messages("telegram").switched, { session: sessionName, replyTarget });
      return;
    }
    if (!isCdAllowed(projectPath, deps.config.cdAllowedDirs)) {
      await reply(ctx, "err", MSG.pathNotAllowed(deps.config.cdAllowedDirs), {
        replyTarget,
      });
      return;
    }
    await createProjectSession(deps, "telegram", sessionName, projectPath);
    await reply(ctx, "ok", messages("telegram").projectCreated, {
      session: sessionName,
      body: projectPath,
      replyTarget,
    });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
  }
}
