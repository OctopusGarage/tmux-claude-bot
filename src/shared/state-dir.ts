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

/** The conventional app home when nothing is configured (`~/.tmux-claude-bot`). */
const DEFAULT_APP_HOME = nodePath.join(homedir(), ".tmux-claude-bot");

/**
 * THE single source of truth for the bot's state-file home — where
 * recent_projects.txt, session_path_map.json, group_bindings.json,
 * .current_project, workspaces.json, .running, the instance lock and .env live.
 *
 * One rule, everywhere: the explicit `TCB_STATE_DIR` env var, else the
 * conventional app home `~/.tmux-claude-bot`. The launchd wrapper exports
 * `TCB_STATE_DIR=<install dir>` (covers a non-default install location); `dev.sh`
 * points it at the deployed instance so a dev session mirrors prod; tests point it
 * at a temp dir.
 *
 * A fixed, cwd-independent home is deliberate:
 *  - the `claude` helper (`claude-tmux.ts`) runs from the user's *project* dir, yet
 *    must share `session_path_map.json` with the bot — a cwd-based dir would split them;
 *  - deriving it from a module's own file location (`dirname(import.meta.url)/../..`)
 *    overshot to `$HOME` once tsup flattened `src/core/x.ts` to `dist/x.js`.
 */
export function appStateDir(): string {
  return stateDir(DEFAULT_APP_HOME);
}

/** Absolute path of a state file under {@link appStateDir}. */
export function appStateFile(name: string): string {
  return nodePath.join(appStateDir(), name);
}
