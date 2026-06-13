import * as nodePath from "node:path";
import { expandTilde } from "../shared/utils/path.js";
import { JsonMapStore } from "./json-map-store.js";

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
  // Normalize the target FIRST (collapse `..`/`.`/`//`) so a traversal like
  // `/allow/root/../secret` can't textually prefix-match its way past the gate.
  // (Symlink resolution is a separate, fs-touching concern left to the caller.)
  const target = nodePath.resolve(targetPath);
  const expanded = allowed.map((d) => nodePath.resolve(expandTilde(d)));
  return expanded.some((dir) => target === dir || target.startsWith(`${dir}${nodePath.sep}`));
}
