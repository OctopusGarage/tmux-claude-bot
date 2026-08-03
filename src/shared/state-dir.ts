import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

/**
 * Low-level primitive: the `TCB_STATE_DIR` override, or the given fallback.
 * Prefer {@link appStateFile} in app code — only {@link appStateDir} decides the
 * fallback, so individual modules never pass their own.
 */
export function stateDir(fallback: string): string {
  return process.env.TCB_STATE_DIR ?? fallback;
}

/** The conventional app home when nothing is configured (`~/.tmux-claude-bot`).
 * This is ALSO the code install dir, which the deploy mirrors with `rsync
 * --delete` — so state must NOT live here directly (see {@link appStateDir}). */
const DEFAULT_APP_HOME = nodePath.join(homedir(), ".tmux-claude-bot");

/** The conventional state dir: a `state/` subdir of the app home. Kept separate
 * from the code install dir so the deploy can exclude it as one directory and
 * never wipe state again (it used to delete group_bindings.json on every deploy). */
const DEFAULT_STATE_DIR = nodePath.join(DEFAULT_APP_HOME, "state");

/**
 * THE single source of truth for the bot's state-file home — where
 * recent_projects.txt, session_path_map.json, group_bindings.json,
 * .current_project, workspaces.json, .running, the instance lock and .env live.
 *
 * One rule, everywhere: the explicit `TCB_STATE_DIR` env var, else the
 * conventional `~/.tmux-claude-bot/state`. The launchd/systemd wrappers export
 * `TCB_STATE_DIR=<install dir>/state` (covers a non-default install location);
 * `dev.sh` points it at the deployed instance's state dir so a dev session mirrors
 * prod; tests point it at a temp dir.
 *
 * The `state/` subdir (not the app home root) is deliberate: the home root is the
 * code install dir, which `install.sh` re-mirrors on every deploy with `rsync
 * --delete`. A state file living at the root that wasn't in the deploy's exclude
 * list got silently deleted — that is the bug this split fixes. State now lives in
 * one excluded subdir; legacy root-level state is relocated on boot by
 * `migrateLegacyStateDir()`.
 *
 * A fixed, cwd-independent home is deliberate:
 *  - the `claude` helper (`claude-tmux.ts`) runs from the user's *project* dir, yet
 *    must share `session_path_map.json` with the bot — a cwd-based dir would split them;
 *  - deriving it from a module's own file location (`dirname(import.meta.url)/../..`)
 *    overshot to `$HOME` once tsup flattened `src/core/x.ts` to `dist/x.js`.
 */
export function appStateDir(): string {
  return normalizeAppStateDir(stateDir(DEFAULT_STATE_DIR));
}

/** Absolute path of a state file under {@link appStateDir}. */
export function appStateFile(name: string): string {
  return nodePath.join(appStateDir(), name);
}

function normalizeAppStateDir(dir: string): string {
  const nested = nodePath.join(dir, "state");
  if (!existsSync(nested)) return dir;
  if (hasPrimaryStateMarker(dir)) return dir;
  if (!looksLikeStateDir(nested)) return dir;
  return nested;
}

function looksLikeStateDir(dir: string): boolean {
  return [
    "loop-runs",
    "logs",
    "group_bindings.json",
    "recent_projects.txt",
    "session_path_map.json",
    ".current_project",
    ".env",
  ].some((name) => existsSync(nodePath.join(dir, name)));
}

function hasPrimaryStateMarker(dir: string): boolean {
  return [
    "loop-runs",
    "group_bindings.json",
    "recent_projects.txt",
    "session_path_map.json",
    ".current_project",
  ].some((name) => existsSync(nodePath.join(dir, name)));
}
