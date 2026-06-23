import * as fs from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { agentGlyph } from "../../shared/types.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { createLogger } from "../../shared/utils/logger.js";
import { expandTilde } from "../../shared/utils/path.js";
import { sleep } from "../../shared/utils/sleep.js";
import { clearAgentKind } from "../agents/agentKindMap.js";
import { listClaudeSessions, projectPathToHistoryDir } from "../agents/claude/claude-history.js";
import { findRolloutForProject } from "../agents/codex/codex-rollout.js";
import { clearLiveSessionId } from "../agents/live-session-id.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { clearStartCommand } from "../agents/startCommandMap.js";
import { clearPicker } from "../autopilot/picker-state.js";
import { clearAutopilotState } from "../autopilot/state-store.js";
import type { HandlerDeps } from "../deps.js";
import { messages } from "../i18n/index.js";
import { clearTaskTiming } from "../session/task-timing.js";
import {
  allocateFreeSlot,
  freeLabel,
  freeSessionName,
  freeSlotOf,
  getFreeProject,
  listFreeSlots,
  releaseFreeSlot,
  setFreeProject,
} from "./free-projects.js";
import { bindingForSession, unbindGroup } from "./group-bindings.js";
import { listUserProjectSessions } from "./operator.js";
import { projectLabel } from "./project-label.js";
import { channelFromScope } from "./project-manager.js";
import { appendRecentProject, readRecentProjectLines } from "./recentProjects.js";
import {
  clearPathForSession,
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "./sessionPathMap.js";

const log = createLogger("projects.project-ops");

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
      await deps.currentProject.set(scope, sessionName);
      setPathForSession(sessionName, resolvedPath);
      await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
      return { status: "switched", sessionName, projectPath: resolvedPath };
    }
    await createProjectSession(deps, scope, sessionName, resolvedPath);
    return { status: "created", sessionName, projectPath: resolvedPath };
  } catch (err) {
    return { status: "error", message: normalizeError(err).message };
  }
}

/** Outcome of `/new_free` — adapters map each status to their own reply. */
export type CreateFreeResult =
  | { status: "created"; sessionName: string; slot: number }
  | { status: "limit" }
  | { status: "error"; message: string };

/**
 * Reconcile the free registry against live tmux, then return the lowest free slot
 * (or null when genuinely full). The SINGLE allocation entry point — folding the
 * prune in means no caller can allocate without it.
 *
 * Prune drops slots whose tmux session is no longer alive — UNLESS a group is
 * still bound to it (the group owns the slot; its next message revives the session
 * via reconcile). Without this, a free session killed outside removeProjectBySession
 * (tmux/server/machine restart, manual kill) leaves its slot "used" forever, so the
 * cap would falsely read as full while /list_alive_projects shows nothing.
 */
export async function allocateFreeSlotPruned(deps: HandlerDeps): Promise<number | null> {
  const live = new Set(await deps.bridge.listProjectSessions());
  const prefix = deps.config.projectSessionPrefix;
  const pruned: number[] = [];
  for (const slot of listFreeSlots()) {
    const name = freeSessionName(prefix, slot);
    if (live.has(name) || bindingForSession(name)) continue;
    releaseFreeSlot(slot);
    pruned.push(slot);
  }
  if (pruned.length > 0) log.info("free slots pruned", { data: { slots: pruned } });
  return allocateFreeSlot();
}

/**
 * Create a "free project": a bare tmux session named `…_free_<n>` (decoupled from
 * any path, so multiple can coexist on the same directory), recorded in the free
 * registry and set as this scope's current project. No cwd and no Claude launch —
 * the user drives it (cd / start) themselves.
 *
 * No lock around allocate→create: the bot is single-process, and the worst a rapid
 * double-tap can do is hand out two distinct slots (two harmless free projects) —
 * never a corrupt registry. The registry write lands AFTER createSession, so a
 * failed create leaves no orphan slot to leak.
 */
export async function createFreeProject(
  deps: HandlerDeps,
  scope: string,
  label: string,
): Promise<CreateFreeResult> {
  const slot = await allocateFreeSlotPruned(deps);
  if (slot === null) return { status: "limit" };
  const sessionName = freeSessionName(deps.config.projectSessionPrefix, slot);
  try {
    await deps.bridge.createSession(sessionName); // bare: no cwd argv
    setFreeProject(slot, { label: label.trim() || null }); // after createSession: no orphan slot on failure
    await deps.currentProject.set(scope, sessionName);
    log.info("free project created", { session: sessionName, data: { channel: scope, slot } });
    return { status: "created", sessionName, slot };
  } catch (err) {
    return { status: "error", message: normalizeError(err).message };
  }
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
  const sessions = (await listUserProjectSessions(deps)).slice().sort();
  return sessions.find((s) => sessionShortId(s) === id) ?? null;
}

/**
 * Spin up a project: create its tmux session in the project directory, record the
 * path mapping, make it the channel's current project, and bump it in recents.
 * The single source of truth for "create a project" — previously copied (with
 * subtly different ordering) across both adapters' add_project / add-recent paths.
 *
 * The pane starts in `projectPath` via `new-session -c` (the path is an argv
 * element, never shell-evaluated), so there is no typed `cd "…"` to inject into —
 * and nothing is ever typed into a session that already existed (it may have
 * Claude running, where a stray `cd` would land in Claude's prompt).
 */
export async function createProjectSession(
  deps: HandlerDeps,
  channel: string,
  sessionName: string,
  projectPath: string,
): Promise<void> {
  await deps.bridge.createSession(sessionName, projectPath);
  setPathForSession(sessionName, projectPath);
  await deps.currentProject.set(channel, sessionName);
  await appendRecentProject(projectPath, deps.config.projectSessionPrefix);
  log.info("project created", { session: sessionName, data: { channel, projectPath } });
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
  log.info("project switched", { session: sessionName, data: { channel } });
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
  const isRunning = await deps.agent.checkIfRunning(sessionName);

  deps.queue.clearSession(sessionName);

  if (isRunning) {
    await deps.bridge.sendExit(sessionName);
    let exited = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (!(await deps.agent.checkIfRunning(sessionName))) {
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
  clearLiveSessionId(sessionName); // drop the last-observed id (a reused free slot must not read it)
  clearTaskTiming(sessionName); // drop cumulative + in-flight timing (a reused name must not read stale data)
  // Drop the recovery roster records so a deleted project isn't resurrected by
  // /recover and a reused free slot reads no stale path/kind/command.
  clearPathForSession(sessionName);
  clearAgentKind(sessionName);
  clearStartCommand(sessionName);
  clearAutopilotState(sessionName); // drop autopilot record (optOut/goalId/viaGlobal) so a reused slot is clean
  clearPicker(sessionName); // drop any in-progress goal-picker selection for a reused slot
  markSessionStopped(sessionName); // drop from the reboot-recovery roster
  // The session is gone — drop it from any channel that had it as current.
  await deps.currentProject.clearSession(sessionName);
  // A free project owns a registry slot — free it so the number can be reused.
  const freeSlot = freeSlotOf(sessionName, deps.config.projectSessionPrefix);
  if (freeSlot !== null) {
    // A free session has no path to re-anchor to, so a group bound to it cannot
    // self-heal via reconcile. Unbind it BEFORE recycling the slot — otherwise a
    // later /new_free could re-allocate free_<n> while the old group still points
    // at that name, and reconcile would recreate it as a shared session.
    const bound = bindingForSession(sessionName);
    if (bound) unbindGroup(bound.chatId);
    releaseFreeSlot(freeSlot);
  }
  log.info("project removed", {
    session: sessionName,
    data: { wasRunning: isRunning, ...(freeSlot !== null ? { freeSlot } : {}) },
  });
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
  const prefix = deps.config.projectSessionPrefix;
  const sessions = await listUserProjectSessions(deps);
  const valid = sessions.filter((session) => {
    if (freeSlotOf(session, prefix) !== null) return true; // free sessions always listed
    const projectPath = getPathBySession(session);
    return projectPath && fs.existsSync(projectPath);
  });
  const currentSession = await deps.currentProject.get(channel);
  return Promise.all(
    valid
      .slice()
      .sort()
      .map(async (session) => {
        const slot = freeSlotOf(session, prefix);
        const path = getPathBySession(session);
        const baseLabel =
          slot !== null
            ? freeLabel(slot, getFreeProject(slot), path)
            : projectLabel(session, path ?? undefined);
        // Decoration runs tmux/agent probes (detectAgentKind, paneCurrentPath)
        // that can reject on a wedged pane — degrade THAT session to its plain
        // base label rather than letting one rejection blank the whole list.
        const label = await decorateAliveLabel(deps, session, path, baseLabel).catch(
          () => baseLabel,
        );
        return { sid: sessionShortId(session), label, active: session === currentSession };
      }),
  );
}

/** A transcript written within this window means the agent is actively working.
 * Slightly above the runner's 5s idle window to bridge brief think gaps. */
const TRANSCRIPT_IDLE_MS = 8_000;

/**
 * Whether the agent's transcript for this session was written within `idleMs` —
 * a cheap, on-demand "is it actively working" signal. The agent appends to its
 * transcript as it streams turns/output, so a fresh write ⇒ working; this also
 * catches work the bot did NOT dispatch (direct pane use), for both agents
 * (claude: newest session under its history dir; codex: the cwd-matched rollout).
 *
 * Prefers the event source — {@link HandlerDeps.activity} reports a fs.watch
 * write within the window with no syscall — and falls back to a `stat` mtime, so
 * a transcript written before the watcher started (e.g. just after a restart)
 * still counts. Best-effort: any failure ⇒ false.
 */
async function transcriptActiveWithin(
  deps: HandlerDeps,
  session: string,
  kind: "claude" | "codex",
  projectPath: string,
  idleMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const path = await resolveTranscriptPath(deps, session, kind, projectPath);
    if (!path) return false;
    if (deps.activity.isActiveWithin(path, idleMs)) return true;
    return now - fs.statSync(path).mtimeMs < idleMs;
  } catch {
    return false;
  }
}

/** Resolve the absolute transcript `.jsonl` for a session's live agent, or null
 * when none exists yet. Codex: the cwd-matched rollout's path. Claude: the newest
 * saved session under the config root, reconstructed to its on-disk path. */
async function resolveTranscriptPath(
  deps: HandlerDeps,
  session: string,
  kind: "claude" | "codex",
  projectPath: string,
): Promise<string | null> {
  // The live agent's OPEN transcript is exact under same-cwd contention (Free
  // Projects) for both agents; only fall back to newest-on-disk when no live pid
  // holds one open (e.g. a stopped session being browsed).
  const live = await deps.configResolver.resolveLiveTranscript?.(session);
  if (live) return live.path;
  if (kind === "codex") {
    const home = await deps.configResolver.resolveCodexHome?.(session);
    return home ? ((await findRolloutForProject(home, projectPath))?.path ?? null) : null;
  }
  const configRoot = await deps.configResolver.resolveConfigRoot(session);
  const newest = (await listClaudeSessions(projectPath, configRoot, 1))[0];
  if (!newest) return null;
  return join(projectPathToHistoryDir(projectPath, configRoot), `${newest.sessionId}.jsonl`);
}

/**
 * Wrap a project-list label with compact status glyphs:
 *   `<agent><busy> <label><mismatch>`
 * - agent: 🟠 claude / 🔘 codex when one is LIVE in the pane, else 💤 (idle).
 * - busy: ⏳ when a task is in flight — the bot queue is processing/queued for
 *   this session, OR the agent's transcript was just written (actively working,
 *   incl. direct pane use; see {@link transcriptActiveWithin}).
 * - mismatch: ⚠️ when the pane's actual cwd has drifted from the bound dir.
 *   Only computed when an agent is live AND both paths are known — a fresh shell
 *   sitting at the bound dir is not a drift.
 */
async function decorateAliveLabel(
  deps: HandlerDeps,
  session: string,
  boundPath: string | null,
  baseLabel: string,
): Promise<string> {
  const liveKind = await deps.configResolver.detectAgentKind?.(session);
  const glyph = agentGlyph(liveKind ?? null);
  // "Has work" — ⏳ — from two complementary signals:
  //  (a) the bot queue: a task is processing OR waiting in this session's queue
  //      (covers bot-dispatched work, incl. things still queued).
  //  (b) the agent's transcript was just written (mtime within the idle window):
  //      the agent appends as it streams turns/output, so a fresh mtime means it
  //      is actively working — and this catches work the bot did NOT dispatch
  //      (you typing directly in the pane), for BOTH agents, with one stat.
  const queueBusy =
    deps.queue.isSessionProcessing(session) || deps.queue.getSessionQueue(session).length > 0;
  // The transcript-busy probe and the cwd-drift probe are independent (each one
  // subprocess) — run them together rather than back-to-back.
  const [agentBusy, actualPath] = await Promise.all([
    !queueBusy && liveKind && boundPath
      ? transcriptActiveWithin(deps, session, liveKind, boundPath, TRANSCRIPT_IDLE_MS)
      : Promise.resolve(false),
    liveKind && boundPath ? deps.bridge.paneCurrentPath(session) : Promise.resolve(null),
  ]);
  const busyGlyph = queueBusy || agentBusy ? "⏳" : "";
  const mismatchGlyph =
    actualPath && boundPath && realpathOrSelf(actualPath) !== realpathOrSelf(boundPath) ? " ⚠️" : "";
  return `${glyph}${busyGlyph} ${baseLabel}${mismatchGlyph}`;
}

/** Resolve a path through realpathSync to normalize symlinks (macOS /var vs
 * /private/var); fall back to the raw string when the path no longer exists. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
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
      await deps.currentProject.set(scope, sessionName);
      await appendRecentProject(projectPath, prefix); // keep recents ordering like switchToProject
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
  const { choices, live } = await projectChoices(deps);
  const currentSession = await deps.currentProject.get(channel);

  // Hide dead dirs (deleted projects) from the UI — resolution stays permissive.
  return [...choices]
    .filter(([, projectPath]) => fs.existsSync(projectPath))
    .map(([sessionName, projectPath]) => ({
      sid: sessionShortId(sessionName),
      label: projectLabel(sessionName, projectPath),
      alive: live.has(sessionName),
      active: currentSession === sessionName,
    }));
}
