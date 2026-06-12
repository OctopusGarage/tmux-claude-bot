import * as fs from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { writeFileAtomicSync } from "../shared/utils/atomic-write.js";
import { appStateFile } from "./state-dir.js";

const sessionPathMapFile = (): string => appStateFile("session_path_map.json");

export function loadSessionPathMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync(sessionPathMapFile(), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveSessionPathMap(map: Record<string, string>): void {
  writeFileAtomicSync(sessionPathMapFile(), JSON.stringify(map, null, 2));
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
