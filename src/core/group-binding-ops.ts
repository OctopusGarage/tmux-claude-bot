import { basename } from "node:path";
import type { HandlerDeps } from "./deps.js";
import { resolveProjectPath } from "./project-ops.js";
import { getPathBySession, sessionNameFromPath } from "./sessionPathMap.js";
import { getWorkspace } from "./workspaces.js";

export type ResolvedTarget =
  | { workspacePath: string; sessionName: string; label: string }
  | {
      error: "not-a-directory" | "not-found" | "not-allowed" | "unknown-workspace";
      resolvedPath?: string;
    };

/**
 * Map a `/newgroup|/bind` argument to a concrete workspace. A saved workspace
 * NAME (workspaces.json) wins; otherwise the argument is treated as a directory
 * path and validated against the cd allow-list.
 */
export async function resolveWorkspaceTarget(
  deps: HandlerDeps,
  raw: string,
): Promise<ResolvedTarget> {
  const arg = raw.trim();
  const prefix = deps.config.projectSessionPrefix;

  // Workspace name path: workspaces.json maps name -> sessionName.
  const wsSession = getWorkspace(arg);
  if (wsSession) {
    const path = getPathBySession(wsSession);
    if (!path) return { error: "unknown-workspace" };
    return { workspacePath: path, sessionName: wsSession, label: arg };
  }

  // Directory path: reuse the single add_project validator.
  const res = await resolveProjectPath(arg, deps.config.cdAllowedDirs);
  if (res.error) return { error: res.error, resolvedPath: res.resolvedPath };
  return {
    workspacePath: res.resolvedPath,
    sessionName: sessionNameFromPath(res.resolvedPath, prefix),
    label: basename(res.resolvedPath),
  };
}
