import * as fs from "node:fs";
import { sessionShortId } from "../shared/utils/hash.js";
import { sleep } from "../shared/utils/sleep.js";
import type { HandlerDeps } from "./deps.js";
import { projectLabel } from "./project-label.js";
import { appendRecentProject, readRecentProjectLines } from "./recentProjects.js";
import { getPathBySession, sessionNameFromPath } from "./sessionPathMap.js";

/**
 * Protocol-agnostic project lifecycle: the single home for everything that
 * switches, removes, or lists the Project ⇄ tmux-session mappings, independent
 * of any chat protocol. Adapters (Telegram, Lark, …) wrap these with their own
 * routing/reply concerns.
 */

/** Neutral data shape for a project list button. */
export interface ProjectButton {
  sid: string;
  label: string;
  active: boolean;
}

/** Neutral data shape for a recent-project list button. */
export interface RecentButton {
  sid: string;
  label: string;
  alive: boolean;
  active: boolean;
}

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
  sessionName: string,
): Promise<void> {
  const current = await deps.currentProject.get();
  const isRunning = await deps.claude.checkIfRunning(sessionName);

  deps.queue.clearSession(sessionName);

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
