import * as nodePath from "node:path";

/**
 * Base directory for the bot's mutable state files (recent_projects.txt,
 * session_path_map.json, .current_project). Defaults to the caller's `fallback`
 * (cwd or the project root) but is overridden by `TCB_STATE_DIR` — tests point
 * it at a temp dir so the suite never writes into the checkout, and dev.sh
 * points it at the deployed instance so a dev session mirrors prod's projects.
 */
export function stateDir(fallback: string): string {
  return process.env.TCB_STATE_DIR ?? fallback;
}

export function stateFile(fallback: string, name: string): string {
  return nodePath.join(stateDir(fallback), name);
}
