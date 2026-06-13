import { JsonMapStore } from "./json-map-store.js";

/** Workspace name constraints: 1-32 chars, letters/digits/hyphens/underscores. */
export const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

const store = new JsonMapStore<string>("workspaces.json");

/** Save the current session under a friendly name. Overwrites any prior mapping. */
export function saveWorkspace(name: string, session: string): void {
  store.set(name, session);
}

/** Return the session name for a workspace, or null if not found. */
export function getWorkspace(name: string): string | null {
  return store.get(name) ?? null;
}

/** All saved workspaces, sorted by name. */
export function listWorkspaces(): Array<{ name: string; session: string }> {
  return store.sortedEntries().map(([name, session]) => ({ name, session }));
}

/** Remove a workspace by name. Returns true if it existed. */
export function removeWorkspace(name: string): boolean {
  return store.delete(name);
}
