import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { appendRecentProject, readRecentProjectLines } from "../../core/recentProjects.js";
import { isCdAllowed, sessionNameFromPath, setPathForSession } from "../../core/sessionPathMap.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { sleep } from "../../shared/utils/sleep.js";
import { MSG } from "./messages.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";

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
      await deps.currentProject.set(sessionName);
      await reply(ctx, "ok", "已切换", { session: sessionName, replyTarget });
      return;
    }
    if (!isCdAllowed(projectPath, deps.config.cdAllowedDirs)) {
      await reply(ctx, "err", MSG.pathNotAllowed(deps.config.cdAllowedDirs), {
        replyTarget,
      });
      return;
    }
    await deps.bridge.createSession(sessionName);
    await deps.currentProject.set(sessionName);
    setPathForSession(sessionName, projectPath);
    await sleep(deps.config.sessionWarmupMs);
    await deps.bridge.sendKeys(`cd "${projectPath}"`);
    await sleep(deps.config.sessionWarmupMs);
    await appendRecentProject(projectPath, prefix);
    await reply(ctx, "ok", "项目已创建", { session: sessionName, body: projectPath, replyTarget });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
  }
}
