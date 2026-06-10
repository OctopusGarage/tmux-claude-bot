import * as fs from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { stateFile } from "./state-dir.js";

// Resolve to project root so bot and claude-tmux.ts share the same file regardless
// of cwd; TCB_STATE_DIR overrides it (tests isolate, dev mirrors prod). Resolved
// per call so the override applies even when set after this module loads.
const projectRoot = nodePath.resolve(
  nodePath.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const sessionPathMapFile = (): string => stateFile(projectRoot, "session_path_map.json");

export function loadSessionPathMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync(sessionPathMapFile(), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveSessionPathMap(map: Record<string, string>): void {
  fs.writeFileSync(sessionPathMapFile(), JSON.stringify(map, null, 2), "utf-8");
}

export function getPathBySession(sessionName: string): string | null {
  const map = loadSessionPathMap();
  return map[sessionName] ?? null;
}

export function setPathForSession(sessionName: string, projectPath: string): void {
  const map = loadSessionPathMap();
  map[sessionName] = projectPath;
  saveSessionPathMap(map);
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
