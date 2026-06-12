import { homedir } from "node:os";
import * as nodePath from "node:path";
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
  const expanded = allowed.map((d) => nodePath.resolve(d.replaceAll("~", homedir())));
  return expanded.some((dir) => targetPath.startsWith(`${dir}/`) || targetPath === dir);
}
