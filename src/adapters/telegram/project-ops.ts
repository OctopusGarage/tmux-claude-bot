import * as fs from "node:fs";
import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { appendRecentProject, readRecentProjectLines } from "../../core/recentProjects.js";
import {
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "../../core/sessionPathMap.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { sleep } from "../../shared/utils/sleep.js";
import type { ProjectButton, RecentButton } from "./keyboards.js";
import { MSG } from "./messages.js";
import { projectLabel } from "./project-label.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";

/**
 * Project lifecycle: the single home for everything that creates, switches,
 * removes, or lists the Project ⇄ tmux-session mappings. Both the slash commands
 * (`/switch_N`, `/remove_N`, `/add_project_N`) and the inline keyboard buttons
 * route through here so the two entry points can never drift.
 */

export async function resolveAliveSessionByShortId(
  deps: HandlerDeps,
  id: string,
): Promise<string | null> {
  const sessions = (await deps.bridge.listProjectSessions()).slice().sort();
  return sessions.find((s) => sessionShortId(s) === id) ?? null;
}

/** Make `sessionName` the current project and bump it in the recents list. */
export async function switchToProject(deps: HandlerDeps, sessionName: string): Promise<void> {
  await deps.currentProject.set(sessionName);
  const projectPath = getPathBySession(sessionName);
  if (projectPath) {
    await appendRecentProject(projectPath, deps.config.projectSessionPrefix);
  }
}

/**
 * Tear down a project session: cancel its queue, exit Claude gracefully (then
 * Ctrl-C as a fallback), kill the tmux session, and clear it as current if it
 * was. Shared by the `/remove_*` command and the inline remove button.
 */
export async function removeProjectBySession(
  deps: HandlerDeps,
  replyTarget: ReplyTargetMap,
  sessionName: string,
): Promise<void> {
  const current = await deps.currentProject.get();
  const isRunning = await deps.claude.checkIfRunning(sessionName);

  deps.queue.clearSession(sessionName);
  replyTarget.removeSession(sessionName);

  if (isRunning) {
    await deps.bridge.sendExit(sessionName);
    let exited = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (!(await deps.claude.checkIfRunning(sessionName))) {
        exited = true;
        break;
      }
    }
    if (!exited) {
      await deps.bridge.sendRawKey("C-c", sessionName);
      await sleep(500);
    }
  }
  await deps.bridge.killSession(sessionName);
  deps.configResolver.invalidate(sessionName);
  if (current === sessionName) {
    await deps.currentProject.clear();
  }
}

/**
 * Alive tmux project sessions (whose directories still exist) as keyboard
 * buttons. Used by `/list_alive_projects` and the delete-mode toggles so they
 * always reflect the same set.
 */
export async function aliveProjectButtons(deps: HandlerDeps): Promise<ProjectButton[]> {
  const sessions = await deps.bridge.listProjectSessions();
  const valid = sessions.filter((session) => {
    const projectPath = getPathBySession(session);
    return projectPath && fs.existsSync(projectPath);
  });
  const currentSession = await deps.currentProject.get();
  return valid
    .slice()
    .sort()
    .map((session) => ({
      sid: sessionShortId(session),
      label: projectLabel(session, getPathBySession(session) ?? undefined),
      active: session === currentSession,
    }));
}

/** Recent projects (existing dirs) as keyboard buttons, with alive/active flags. */
export async function recentProjectButtons(deps: HandlerDeps): Promise<RecentButton[]> {
  const paths = (await readRecentProjectLines()).filter((p) => fs.existsSync(p));
  const currentSession = await deps.currentProject.get();
  const prefix = deps.config.projectSessionPrefix;
  return Promise.all(
    paths.map(async (projectPath) => {
      const sessionName = sessionNameFromPath(projectPath, prefix);
      return {
        sid: sessionShortId(sessionName),
        label: projectLabel(sessionName, projectPath),
        alive: await deps.bridge.hasSession(sessionName),
        active: currentSession === sessionName,
      };
    }),
  );
}

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
