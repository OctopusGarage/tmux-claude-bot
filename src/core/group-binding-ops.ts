import * as fs from "node:fs";
import { basename } from "node:path";
import type { HandlerDeps } from "./deps.js";
import { getBinding } from "./group-bindings.js";
import { type Channel, chatScope } from "./project-manager.js";
import { createProjectSession, resolveProjectPath, switchToProject } from "./project-ops.js";
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

export type ReconcileResult =
  | { status: "ok"; sessionName: string }
  | { status: "restored"; sessionName: string; label: string }
  | { status: "missing-path"; label: string }
  | { status: "unbound" };

/**
 * Ensure the group's current-project pointer equals its binding. Re-anchors a
 * drifted pointer and recreates the tmux session if it died. The binding (not the
 * volatile .current_project) is the source of truth, so a group can always come
 * home even after `clearSession` wiped the pointer.
 */
export async function reconcileGroupBinding(
  deps: HandlerDeps,
  channel: Channel,
  chatId: string,
): Promise<ReconcileResult> {
  const binding = getBinding(chatId);
  if (!binding) return { status: "unbound" };

  // Only a genuinely ABSENT path is "missing"; a transient stat error (EACCES /
  // EBUSY on a mount/permission blip) must NOT brick the group — proceed and let
  // reconcile try, rather than falsely reporting the dir gone.
  try {
    fs.statSync(binding.workspacePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing-path", label: binding.label };
    }
  }

  // `sessionName` is authoritative — it is set deliberately at bind time, and for
  // a `/bind <workspace-name>` it is the SAVED workspace's session, NOT
  // sessionNameFromPath(workspacePath). Do not re-derive it.
  const sessionName = binding.sessionName;

  const scope = chatScope(channel, chatId);
  const pointer = await deps.currentProject.get(scope);
  const alive = await deps.bridge.hasSession(sessionName);

  if (pointer === sessionName && alive) {
    return { status: "ok", sessionName };
  }

  if (!alive) {
    // Recreate at the bound path; createProjectSession also sets current + cd.
    await createProjectSession(deps, scope, sessionName, binding.workspacePath);
  } else {
    await switchToProject(deps, scope, sessionName);
  }
  return { status: "restored", sessionName, label: binding.label };
}
