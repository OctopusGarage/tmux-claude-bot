import * as fs from "node:fs";
import * as nodePath from "node:path";
import { expandTilde } from "../shared/utils/path.js";
import { JsonMapStore } from "./json-map-store.js";

/** Resolve a path lexically AND through symlinks, so a symlink inside an
 * allow-listed root can't point the cwd outside it. For a path that doesn't
 * exist yet (a project dir about to be created), realpath its LONGEST EXISTING
 * ancestor and re-append the not-yet-existing tail — so a symlinked parent is
 * still caught. Walking up consistently (vs. just one level) keeps two paths
 * under one root comparable regardless of how much of each exists, avoiding a
 * `/var` vs `/private/var` split on macOS. */
function canonicalize(p: string): string {
  const resolved = nodePath.resolve(p);
  const tail: string[] = [];
  let dir = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return tail.length > 0 ? nodePath.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = nodePath.dirname(dir);
      if (parent === dir) return resolved; // reached the fs root, nothing exists — lexical
      tail.push(nodePath.basename(dir));
      dir = parent;
    }
  }
}

// Shared with the `claude-tmux` helper, which writes this file from the user's
// project dir — the store's mtime-keyed cache picks up those foreign writes.
const store = new JsonMapStore<string>("session_path_map.json");

export function getPathBySession(sessionName: string): string | null {
  return store.get(sessionName) ?? null;
}

export function setPathForSession(sessionName: string, projectPath: string): void {
  store.set(sessionName, projectPath);
}

export function sessionNameFromPath(projectPath: string, prefix: string): string {
  const absPath = nodePath.resolve(projectPath);
  return prefix + absPath.replace(/\//g, "-");
}

export function isCdAllowed(targetPath: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  // Canonicalize BOTH sides through `..`/`.`/`//` collapse AND symlinks, so
  // neither a textual traversal (`/allow/root/../secret`) nor a symlink planted
  // inside an allow-listed root (`root/link -> /etc`) can escape the gate.
  const target = canonicalize(targetPath);
  const expanded = allowed.map((d) => canonicalize(expandTilde(d)));
  return expanded.some((dir) => target === dir || target.startsWith(`${dir}${nodePath.sep}`));
}
