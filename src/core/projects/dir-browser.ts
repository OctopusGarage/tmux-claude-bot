import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandTilde } from "../../shared/utils/path.js";
import { isCdAllowed } from "./sessionPathMap.js";

/**
 * Protocol-agnostic directory browser for the "pick a project location" flow.
 * A chat has no tree widget, so navigation is a level-by-level drill-down: an
 * adapter renders the current directory's subdirectories as buttons and maps
 * taps back to the actions here. All navigation/boundary logic lives in this
 * module; adapters only render the returned `BrowseView`.
 */

/** Subdirectory buttons shown per page (keeps the keyboard/card compact). */
export const BROWSE_PAGE_SIZE = 8;
/** Idle navigation state is dropped after this long (transient interaction). */
const NAV_TTL_MS = 10 * 60 * 1000;

export interface DirEntry {
  name: string;
  path: string;
}

/** A navigation tap. `select`/`cancel` are terminal and handled by the adapter
 * (create the project at `browseCwd`, or clear state) — they are not view moves. */
export type BrowseAction =
  | { kind: "open"; index: number }
  | { kind: "root"; index: number }
  | { kind: "up" }
  | { kind: "page"; page: number };

export interface BrowseView {
  kind: "roots" | "dir";
  /** Home-compressed path shown as the breadcrumb (empty on the roots screen). */
  displayPath: string;
  /** Entries on the current page; `index` is the absolute index for callbacks.
   *  `isRepo` flags a directory that contains a `.git` (a likely project root). */
  entries: { label: string; index: number; isRepo: boolean }[];
  /** A move up is possible (to a parent dir, or back to the roots screen). */
  canGoUp: boolean;
  /** A project can be created at the current dir (false on roots / read errors). */
  canCreate: boolean;
  /** Absolute path to create a project at; null on the roots screen. */
  cwd: string | null;
  page: number;
  totalPages: number;
  error?: "unreadable" | "escaped";
}

interface NavState {
  cwd: string | null; // null = the roots-selection screen
  page: number;
  at: number;
}

const navStates = new Map<string, NavState>();

/**
 * Roots that browsing is confined to: the configured allow-list, or `$HOME`
 * when unset. Unlike `isCdAllowed`'s empty-list case, browsing is NEVER
 * unrestricted — an empty allow-list still pins navigation to the home dir.
 */
export function browseRoots(cdAllowedDirs: readonly string[]): string[] {
  const roots = cdAllowedDirs.length > 0 ? [...cdAllowedDirs] : [homedir()];
  return roots.map((d) => resolve(expandTilde(d)));
}

/** Compress a leading `$HOME` to `~` for a shorter breadcrumb. */
export function displayPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}

/**
 * Subdirectories of `dirPath` confined to `roots`: real directories only
 * (symlinks are skipped, which also prevents escape past a root and traversal
 * cycles), hidden dot-dirs filtered out, sorted by name.
 */
export function listSubdirs(
  dirPath: string,
  roots: readonly string[],
): { entries: DirEntry[]; error?: "unreadable" | "escaped" } {
  const cwd = resolve(dirPath);
  if (!isCdAllowed(cwd, roots)) return { entries: [], error: "escaped" };
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return { entries: [], error: "unreadable" };
  }
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: join(cwd, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { entries };
}

/** True when `dir` looks like a git working tree (has a `.git` entry — a dir for
 * a normal clone, a file for a worktree/submodule). Best-effort; never throws. */
function isGitRepo(dir: string): boolean {
  return fs.existsSync(join(dir, ".git"));
}

/** Up is possible when the parent is still inside a root, or (at a root
 * boundary) when there is more than one root to fall back to. */
function canGoUp(cwd: string, roots: string[]): boolean {
  const parent = dirname(cwd);
  if (parent !== cwd && isCdAllowed(parent, roots)) return true;
  return roots.length > 1;
}

function buildView(state: NavState, roots: string[]): BrowseView {
  if (state.cwd === null) {
    return {
      kind: "roots",
      displayPath: "",
      entries: roots.map((r, i) => ({ label: displayPath(r), index: i, isRepo: false })),
      canGoUp: false,
      canCreate: false,
      cwd: null,
      page: 0,
      totalPages: 1,
    };
  }
  const { entries: all, error } = listSubdirs(state.cwd, roots);
  const totalPages = Math.max(1, Math.ceil(all.length / BROWSE_PAGE_SIZE));
  const page = Math.min(Math.max(0, state.page), totalPages - 1);
  const start = page * BROWSE_PAGE_SIZE;
  // The `.git` probe is limited to the current page (≤8 entries) so paging a huge
  // directory doesn't stat every child.
  const entries = all
    .slice(start, start + BROWSE_PAGE_SIZE)
    .map((e, i) => ({ label: e.name, index: start + i, isRepo: isGitRepo(e.path) }));
  return {
    kind: "dir",
    displayPath: displayPath(state.cwd),
    entries,
    canGoUp: canGoUp(state.cwd, roots),
    canCreate: !error,
    cwd: state.cwd,
    page,
    totalPages,
    ...(error ? { error } : {}),
  };
}

function freshState(roots: string[], now: number): NavState {
  // One root → drop straight into it; many → start on the roots-selection screen.
  return { cwd: roots.length === 1 ? (roots[0] ?? null) : null, page: 0, at: now };
}

/** Begin (or restart) browsing for a scope and return the first view. */
export function startBrowse(scope: string, cdAllowedDirs: readonly string[]): BrowseView {
  const now = Date.now();
  prune(now);
  const roots = browseRoots(cdAllowedDirs);
  const state = freshState(roots, now);
  navStates.set(scope, state);
  return buildView(state, roots);
}

/** Apply a navigation tap and return the new view (re-lists the dir live, so the
 * listing and the indices the adapter renders always match the current fs). */
export function resolveBrowseAction(
  scope: string,
  action: BrowseAction,
  cdAllowedDirs: readonly string[],
): BrowseView {
  const now = Date.now();
  prune(now);
  const roots = browseRoots(cdAllowedDirs);
  const state = navStates.get(scope) ?? freshState(roots, now);
  state.at = now;
  pendingFolders.delete(scope); // navigating abandons any pending new-folder prompt

  switch (action.kind) {
    case "root":
      state.cwd = roots[action.index] ?? state.cwd;
      state.page = 0;
      break;
    case "open":
      if (state.cwd !== null) {
        const target = listSubdirs(state.cwd, roots).entries[action.index];
        if (target) {
          state.cwd = target.path;
          state.page = 0;
        }
      }
      break;
    case "up":
      if (state.cwd !== null) {
        const parent = dirname(state.cwd);
        if (parent !== state.cwd && isCdAllowed(parent, roots)) state.cwd = parent;
        else if (roots.length > 1) state.cwd = null;
        state.page = 0;
      }
      break;
    case "page":
      state.page = Math.max(0, action.page);
      break;
  }

  navStates.set(scope, state);
  return buildView(state, roots);
}

/** The directory a `select` would create a project at, or null if none/expired. */
export function browseCwd(scope: string): string | null {
  return navStates.get(scope)?.cwd ?? null;
}

// --- New-folder sub-flow ----------------------------------------------------
// A chat has no inline text field, so creating a folder is a two-step capture:
// the "new folder" tap remembers the target dir, then the user's next text
// message is taken as the folder name. State is per-scope with a short TTL.

const NEWFOLDER_TTL_MS = 5 * 60 * 1000;
const pendingFolders = new Map<string, { cwd: string; at: number }>();

/** Start a "new folder" capture for the scope's current dir. Returns that dir
 * (to show in the prompt), or null when not browsing a directory. */
export function requestNewFolder(scope: string): string | null {
  const cwd = navStates.get(scope)?.cwd ?? null;
  if (cwd === null) return null;
  pendingFolders.set(scope, { cwd, at: Date.now() });
  return cwd;
}

/** True while the scope's next text message should be taken as a folder name. */
export function isAwaitingFolderName(scope: string): boolean {
  const pending = pendingFolders.get(scope);
  if (!pending) return false;
  if (Date.now() - pending.at > NEWFOLDER_TTL_MS) {
    pendingFolders.delete(scope);
    return false;
  }
  return true;
}

export type NewFolderResult =
  | { ok: true; view: BrowseView }
  | { ok: false; reason: "expired" | "invalid" | "exists" | "error" };

/**
 * Create `name` inside the scope's pending dir, then enter it and return the
 * new view (so the user can immediately "create project here"). The name must be
 * a single path segment — no `/`, no `.`/`..` traversal — and must not already
 * exist. Consumes the pending capture either way.
 */
export function createSubfolder(
  scope: string,
  name: string,
  cdAllowedDirs: readonly string[],
): NewFolderResult {
  const pending = pendingFolders.get(scope);
  pendingFolders.delete(scope);
  if (!pending || Date.now() - pending.at > NEWFOLDER_TTL_MS)
    return { ok: false, reason: "expired" };

  const clean = name.trim();
  if (!clean || clean.includes("/") || clean === "." || clean === "..") {
    return { ok: false, reason: "invalid" };
  }
  const roots = browseRoots(cdAllowedDirs);
  const target = join(pending.cwd, clean);
  if (!isCdAllowed(target, roots)) return { ok: false, reason: "invalid" };
  if (fs.existsSync(target)) return { ok: false, reason: "exists" };
  try {
    fs.mkdirSync(target);
  } catch {
    return { ok: false, reason: "error" };
  }

  const state = navStates.get(scope) ?? freshState(roots, Date.now());
  state.cwd = target;
  state.page = 0;
  state.at = Date.now();
  navStates.set(scope, state);
  return { ok: true, view: buildView(state, roots) };
}

/** Drop a scope's navigation state (on cancel or after a project is created). */
export function clearBrowse(scope: string): void {
  navStates.delete(scope);
  pendingFolders.delete(scope);
}

function prune(now: number): void {
  for (const [scope, state] of navStates) {
    if (now - state.at > NAV_TTL_MS) navStates.delete(scope);
  }
}
