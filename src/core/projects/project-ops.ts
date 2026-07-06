import * as fs from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { expandTilde } from "../../shared/utils/path.js";
import type { HandlerDeps } from "../deps.js";
import { messages } from "../i18n/index.js";
import { listUserProjectSessions } from "./operator.js";
import { channelFromScope } from "./project-manager.js";
import { createProjectSession, switchToProject } from "./project-session-lifecycle.js";
import { projectPickerRows } from "./project-session-picker.js";
import type { ProjectButton, RecentButton } from "./project-session-summary.js";

export {
  allocateFreeSlotPruned,
  createFreeProject,
  createProjectSession,
  removeProjectBySession,
  switchToProject,
} from "./project-session-lifecycle.js";

import { readRecentProjectLines } from "./recentProjects.js";
import { getPathBySession, isCdAllowed, sessionNameFromPath } from "./sessionPathMap.js";

export type {
  ProjectButton,
  ProjectSessionSummary,
  RecentButton,
} from "./project-session-summary.js";

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
  const resolvedPath = resolvePath(expandTilde(rawPath));
  try {
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) return { resolvedPath, error: "not-a-directory" };
  } catch {
    return { resolvedPath, error: "not-found" };
  }
  if (!isCdAllowed(resolvedPath, cdAllowedDirs)) return { resolvedPath, error: "not-allowed" };
  return { resolvedPath };
}

/** Outcome of creating a project from a raw path — the adapter maps each status
 *  to its own reply surface (mirrors {@link OpenRecentResult}). */
export type CreateProjectResult =
  | { status: "invalid"; error: NonNullable<ResolveProjectResult["error"]>; resolvedPath: string }
  | { status: "switched"; sessionName: string; projectPath: string }
  | { status: "created"; sessionName: string; projectPath: string }
  | { status: "error"; message: string };

/**
 * Validate a raw path and either switch to its existing session or create one —
 * the single decision behind `/add_project <path>` (both adapters) and the
 * directory-browser "create here" button. Adapters map the returned status to
 * their own replies; only the validation/switch/create logic lives here.
 */
export async function createProjectFromPath(
  deps: HandlerDeps,
  scope: string,
  rawPath: string,
): Promise<CreateProjectResult> {
  const { resolvedPath, error } = await resolveProjectPath(rawPath, deps.config.cdAllowedDirs);
  if (error) return { status: "invalid", error, resolvedPath };
  const sessionName = sessionNameFromPath(resolvedPath, deps.config.projectSessionPrefix);
  try {
    const live = await deps.bridge.hasSession(sessionName);
    // Guard the path↔session bijection: sessionNameFromPath maps both `/` and `-`
    // to `-`, so distinct dirs (e.g. /a/b-c and /a-b/c) can collide on one session
    // name. If a LIVE session for this name already belongs to a DIFFERENT path,
    // refuse rather than silently switch the user into the wrong project.
    const mapped = getPathBySession(sessionName);
    if (live && mapped !== null && mapped !== resolvedPath) {
      return {
        status: "error",
        message: messages(channelFromScope(scope)).projectPathCollision(mapped),
      };
    }
    if (live) {
      await switchToProject(deps, scope, sessionName, resolvedPath);
      return { status: "switched", sessionName, projectPath: resolvedPath };
    }
    await createProjectSession(deps, scope, sessionName, resolvedPath);
    return { status: "created", sessionName, projectPath: resolvedPath };
  } catch (err) {
    return { status: "error", message: normalizeError(err).message };
  }
}

export async function resolveAliveSessionByShortId(
  deps: HandlerDeps,
  id: string,
): Promise<string | null> {
  const sessions = (await listUserProjectSessions(deps)).slice().sort();
  return sessions.find((s) => sessionShortId(s) === id) ?? null;
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
 * Alive project sessions (whose directories still exist) as keyboard
 * buttons. Used by `/list_alive_projects` and the delete-mode toggles so they
 * always reflect the same set.
 */
export async function aliveProjectButtons(
  deps: HandlerDeps,
  channel: string,
): Promise<ProjectButton[]> {
  return projectPickerRows(deps, channel, "project-sessions");
}

/** Outcome of opening a recent project by short id — the adapter maps each
 *  status to its own reply surface. */
export type OpenRecentResult =
  | { status: "not-found" }
  | { status: "switched"; sessionName: string }
  | { status: "not-allowed"; projectPath: string }
  | { status: "created"; sessionName: string; projectPath: string }
  | { status: "error"; message: string };

/**
 * Resolve a recent project by its short id, then open it: switch to its live
 * session, or (re)create one at its path (allow-list permitting). Shared
 * decision logic behind the Telegram `/add_project_<sid>` command and the Lark
 * recent-list "create" button — only the replies differed, so each adapter now
 * maps this result to its own surface.
 */
export async function openRecentProjectBySid(
  deps: HandlerDeps,
  scope: string,
  sid: string,
): Promise<OpenRecentResult> {
  const prefix = deps.config.projectSessionPrefix;
  const projectPath = await resolveProjectPathByShortId(deps, sid);
  if (!projectPath) return { status: "not-found" };
  const sessionName = sessionNameFromPath(projectPath, prefix);
  try {
    if (await deps.bridge.hasSession(sessionName)) {
      await switchToProject(deps, scope, sessionName, projectPath);
      return { status: "switched", sessionName };
    }
    if (!isCdAllowed(projectPath, deps.config.cdAllowedDirs)) {
      return { status: "not-allowed", projectPath };
    }
    await createProjectSession(deps, scope, sessionName, projectPath);
    return { status: "created", sessionName, projectPath };
  } catch (err) {
    return { status: "error", message: normalizeError(err).message };
  }
}

/**
 * The set of projects a picker / recent list offers, as `session → path` in
 * display order: recents (existing dirs, LRU) first, then any LIVE tmux project
 * not already listed. A project started directly in tmux (outside the bot) never
 * enters the recents file, but the user is working in it, so it must be both
 * SHOWN and ACTIONABLE — hence this single source is used by both the buttons and
 * the short-id resolver, so display and resolution can never disagree.
 */
async function projectChoices(
  deps: HandlerDeps,
): Promise<{ choices: Map<string, string>; live: Set<string> }> {
  const prefix = deps.config.projectSessionPrefix;
  // One `tmux list-sessions` for the liveness lookup, instead of spawning a
  // `tmux has-session` subprocess per recent path (up to 15).
  const live = new Set(await listUserProjectSessions(deps));
  // Raw set, NOT filtered by on-disk existence — resolution must accept any sid a
  // picker could show (the caller / create path handles a missing dir). The button
  // builder applies the existence filter for display only.
  const choices = new Map<string, string>();
  for (const p of await readRecentProjectLines()) {
    choices.set(sessionNameFromPath(p, prefix), p);
  }
  for (const sessionName of live) {
    if (choices.has(sessionName)) continue;
    const p = getPathBySession(sessionName);
    if (p) choices.set(sessionName, p);
  }
  return { choices, live };
}

/** Resolve a project short id to its absolute path over the SAME set the pickers
 * show (recents ∪ live), so any button shown can be acted on — including a live
 * project absent from recents (the "Short id not found" bug). */
export async function resolveProjectPathByShortId(
  deps: HandlerDeps,
  sid: string,
): Promise<string | null> {
  const { choices } = await projectChoices(deps);
  for (const [sessionName, projectPath] of choices) {
    if (sessionShortId(sessionName) === sid) return projectPath;
  }
  return null;
}

/** Recent projects (existing dirs) as keyboard buttons, with alive/active flags. */
export async function recentProjectButtons(
  deps: HandlerDeps,
  channel: string,
): Promise<RecentButton[]> {
  return projectPickerRows(deps, channel, "recent-projects");
}
