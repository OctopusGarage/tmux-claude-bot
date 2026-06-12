import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Resolve the install/repo root (the nearest ancestor with a `package.json`) from
 * a module's `import.meta.url`. State-file modules use this as their `stateFile`
 * fallback so bot and `claude-tmux` share one state dir regardless of cwd.
 *
 * Robust to bundling: a fixed `../..` assumes the `src/core/x.ts` depth and
 * OVERSHOOTS once tsup flattens the module to `dist/x.js` (resolving to `$HOME`
 * instead of the install dir — the cause of "0 active projects" after a tarball
 * deploy). Walking up to `package.json` lands on the repo root in source AND the
 * install dir in the bundle.
 */
export function stateRootFromModule(importMetaUrl: string): string {
  const start = nodePath.dirname(fileURLToPath(importMetaUrl));
  let dir = start;
  for (let i = 0; i < 30 && dir !== nodePath.dirname(dir); i++) {
    if (existsSync(nodePath.join(dir, "package.json"))) return dir;
    dir = nodePath.dirname(dir);
  }
  return start;
}

export function stateFile(fallback: string, name: string): string {
  return nodePath.join(stateDir(fallback), name);
}
