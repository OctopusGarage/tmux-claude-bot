import * as fs from "node:fs";
import { join } from "node:path";
import { sessionShortId } from "../shared/utils/hash.js";
import { sleep } from "../shared/utils/sleep.js";
import type { HandlerDeps } from "./deps.js";
import { projectLabel } from "./project-label.js";
import type { Channel } from "./project-manager.js";
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

/** Make `sessionName` the current project FOR THIS CHANNEL and bump it in the
 * (shared) recents list. */
export async function switchToProject(
  deps: HandlerDeps,
  channel: Channel,
  sessionName: string,
): Promise<void> {
  await deps.currentProject.set(channel, sessionName);
  const projectPath = getPathBySession(sessionName);
  if (projectPath) {
    await appendRecentProject(projectPath, deps.config.projectSessionPrefix);
  }
}

/**
 * Driving a tmux-claude-bot checkout via the bot is almost always the nesting
 * trap: the bot types into a Claude session running in its OWN code — frequently
 * the very conversation that controls the bot — so replies loop and the user sees
 * only the ack ("已接收") with no result. Returns a warning to surface on switch,
 * or null when the path is not a tmux-claude-bot checkout.
 */
export function botSelfRepoWarning(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(join(projectPath, "package.json"), "utf8"));
    if (pkg?.name === "tmux-claude-bot") {
      return "⚠️ 这是 tmux-claude-bot 自己的代码库——用 bot 驱动它通常会嵌套(只回「已接收」无结果)。建议切到别的真实项目。";
    }
  } catch {
    /* no/unreadable package.json -> not a checkout */
  }
  return null;
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
  // The session is gone — drop it from any channel that had it as current.
  await deps.currentProject.clearSession(sessionName);
}

/**
 * Alive tmux project sessions (whose directories still exist) as keyboard
 * buttons. Used by `/list_alive_projects` and the delete-mode toggles so they
 * always reflect the same set.
 */
export async function aliveProjectButtons(
  deps: HandlerDeps,
  channel: Channel,
): Promise<ProjectButton[]> {
  const sessions = await deps.bridge.listProjectSessions();
  const valid = sessions.filter((session) => {
    const projectPath = getPathBySession(session);
    return projectPath && fs.existsSync(projectPath);
  });
  const currentSession = await deps.currentProject.get(channel);
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
export async function recentProjectButtons(
  deps: HandlerDeps,
  channel: Channel,
): Promise<RecentButton[]> {
  const paths = (await readRecentProjectLines()).filter((p) => fs.existsSync(p));
  const currentSession = await deps.currentProject.get(channel);
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
