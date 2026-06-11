import * as fs from "node:fs";
import * as nodePath from "node:path";
import { stateFile } from "./state-dir.js";

function workspacesFile(): string {
  return stateFile(process.cwd(), "workspaces.json");
}

/** Workspace name constraints: 1-32 chars, letters/digits/hyphens/underscores. */
export const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

type WorkspaceMap = Record<string, string>;

function readMap(): WorkspaceMap {
  try {
    return JSON.parse(fs.readFileSync(workspacesFile(), "utf-8")) as WorkspaceMap;
  } catch {
    return {};
  }
}

function writeMap(map: WorkspaceMap): void {
  const file = workspacesFile();
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, "utf-8");
}

/** Save the current session under a friendly name. Overwrites any prior mapping. */
export function saveWorkspace(name: string, session: string): void {
  const map = readMap();
  map[name] = session;
  writeMap(map);
}

/** Return the session name for a workspace, or null if not found. */
export function getWorkspace(name: string): string | null {
  return readMap()[name] ?? null;
}

/** All saved workspaces, sorted by name. */
export function listWorkspaces(): Array<{ name: string; session: string }> {
  return Object.entries(readMap())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, session]) => ({ name, session }));
}

/** Remove a workspace by name. Returns true if it existed. */
export function removeWorkspace(name: string): boolean {
  const map = readMap();
  if (!(name in map)) return false;
  delete map[name];
  writeMap(map);
  return true;
}
