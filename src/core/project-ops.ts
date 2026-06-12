import * as fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { sessionShortId } from "../shared/utils/hash.js";
import { sleep } from "../shared/utils/sleep.js";
import type { HandlerDeps } from "./deps.js";
import { messages } from "./i18n/index.js";
import { projectLabel } from "./project-label.js";
import { channelFromScope } from "./project-manager.js";
import { appendRecentProject, readRecentProjectLines } from "./recentProjects.js";
import {
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "./sessionPathMap.js";

/** Outcome of validating a raw `/add_project` path. `resolvedPath` is always the
 * expanded absolute path (handy for the error message); `error` says why it was
 * rejected, or is absent when the path is a usable, allow-listed directory. */
export type ResolveProjectResult = {
  resolvedPath: string;
  error?: "not-a-directory" | "not-found" | "not-allowed";
};

/**
 * Expand `~`, resolve to an absolute path, and check it is an existing directory
 * inside the cd allow-list. The single validation used by both adapters'
 * `/add_project` — each maps the `error` to its own reply.
 */
export async function resolveProjectPath(
  rawPath: string,
  cdAllowedDirs: readonly string[],
): Promise<ResolveProjectResult> {
  const resolvedPath = resolvePath(rawPath.replaceAll("~", homedir()));
  try {
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) return { resolvedPath, error: "not-a-directory" };
  } catch {
    return { resolvedPath, error: "not-found" };
  }
  if (!isCdAllowed(resolvedPath, cdAllowedDirs)) return { resolvedPath, error: "not-allowed" };
  return { resolvedPath };
}

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

/**
 * Spin up a project: create its tmux session, record the path mapping, make it
 * the channel's current project, cd into the directory, and bump it in recents.
 * The single source of truth for "create a project" — previously copied (with
 * subtly different ordering) across both adapters' add_project / add-recent paths.
 *
 * The cd is sent to `sessionName` EXPLICITLY rather than the channel default, so a
 * Feishu create can't land its `cd` in Telegram's current session when both
 * channels have a current project set.
 */
export async function createProjectSession(
  deps: HandlerDeps,
  channel: string,
  sessionName: string,
  projectPath: string,
): Promise<void> {
  await deps.bridge.createSession(sessionName);
  setPathForSession(sessionName, projectPath); // record before cd so it survives a cd failure
  await deps.currentProject.set(channel, sessionName);
  await sleep(deps.config.sessionWarmupMs);
  await deps.bridge.sendKeys(`cd "${projectPath}"`, sessionName);
  await sleep(deps.config.sessionWarmupMs);
  await appendRecentProject(projectPath, deps.config.projectSessionPrefix);
}

/** Make `sessionName` the current project FOR THIS CHANNEL and bump it in the
 * (shared) recents list. */
export async function switchToProject(
  deps: HandlerDeps,
  channel: string,
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
 * only the ack ("received") with no result. Returns a warning to surface on switch,
 * or null when the path is not a tmux-claude-bot checkout.
 */
export function botSelfRepoWarning(
  projectPath: string | null | undefined,
  scope: string = "telegram",
): string | null {
  if (!projectPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(join(projectPath, "package.json"), "utf8"));
    if (pkg?.name === "tmux-claude-bot") {
      return messages(channelFromScope(scope)).nestingWarning;
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
  channel: string,
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
  channel: string,
): Promise<RecentButton[]> {
  const paths = (await readRecentProjectLines()).filter((p) => fs.existsSync(p));
  const currentSession = await deps.currentProject.get(channel);
  const prefix = deps.config.projectSessionPrefix;
  // One `tmux list-sessions` for the liveness lookup, instead of spawning a
  // `tmux has-session` subprocess per recent path (up to 15).
  const live = new Set(await deps.bridge.listProjectSessions());
  return paths.map((projectPath) => {
    const sessionName = sessionNameFromPath(projectPath, prefix);
    return {
      sid: sessionShortId(sessionName),
      label: projectLabel(sessionName, projectPath),
      alive: live.has(sessionName),
      active: currentSession === sessionName,
    };
  });
}
