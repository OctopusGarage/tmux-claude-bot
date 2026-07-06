import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { clearAgentRuntimeRecord } from "../agents/agent-runtime-records.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { clearPicker } from "../autopilot/picker-state.js";
import { clearAutopilotState } from "../autopilot/state-store.js";
import type { HandlerDeps } from "../deps.js";
import { clearTaskTiming } from "../session/task-timing.js";
import {
  allocateFreeSlot,
  freeSessionName,
  freeSlotOf,
  listFreeSlots,
  releaseFreeSlot,
  setFreeProject,
} from "./free-projects.js";
import { bindingForSession, unbindGroup } from "./group-bindings.js";
import { appendRecentProject } from "./recentProjects.js";
import { clearReplyTarget } from "./session-reply-target.js";
import { clearPathForSession, getPathBySession, setPathForSession } from "./sessionPathMap.js";

const log = createLogger("projects.session-lifecycle");

/**
 * Spin up a regular project session in its workspace, record the path mapping,
 * make it current for this chat scope, and refresh the Recent Project index.
 *
 * This is the lifecycle module's creation interface: callers do not need to know
 * which durable records make a regular Project Session routable after restart.
 */
export async function createProjectSession(
  deps: HandlerDeps,
  scope: string,
  sessionName: string,
  projectPath: string,
): Promise<void> {
  await deps.bridge.createSession(sessionName, projectPath);
  setPathForSession(sessionName, projectPath);
  await deps.currentProject.set(scope, sessionName);
  await appendRecentProject(projectPath, deps.config.projectSessionPrefix);
  log.info("project created", { session: sessionName, data: { scope, projectPath } });
}

/**
 * Make an existing project session current for this chat scope and refresh the
 * Recent Project index. When a trusted path is supplied by the caller, record it
 * before refreshing recents so live desktop-created sessions self-heal.
 */
export async function switchToProject(
  deps: HandlerDeps,
  scope: string,
  sessionName: string,
  projectPath?: string,
): Promise<void> {
  if (projectPath !== undefined) setPathForSession(sessionName, projectPath);
  await deps.currentProject.set(scope, sessionName);
  const path = projectPath ?? getPathBySession(sessionName);
  if (path) {
    await appendRecentProject(path, deps.config.projectSessionPrefix);
  }
  log.info("project switched", { session: sessionName, data: { scope } });
}

/** Outcome of creating an independent Project Session. */
export type CreateFreeResult =
  | { status: "created"; sessionName: string; slot: number }
  | { status: "limit" }
  | { status: "error"; message: string };

/**
 * Reconcile the independent-session registry against live sessions, then return
 * the lowest free slot. Bound-but-dead slots stay reserved because their Project
 * Group owns the session name and can restore it later.
 */
export async function allocateFreeSlotPruned(deps: HandlerDeps): Promise<number | null> {
  const live = new Set(await deps.bridge.listProjectSessions());
  const prefix = deps.config.projectSessionPrefix;
  const pruned: number[] = [];
  for (const slot of listFreeSlots()) {
    const name = freeSessionName(prefix, slot);
    if (live.has(name) || bindingForSession(name)) continue;
    releaseFreeSlot(slot);
    pruned.push(slot);
  }
  if (pruned.length > 0) log.info("free slots pruned", { data: { slots: pruned } });
  return allocateFreeSlot();
}

/**
 * Create an independent Project Session: allocate a slot, create a bare tmux
 * session, record the independent-slot fact, then make it current for this
 * chat scope. No workspace path is implied here.
 */
export async function createFreeProject(
  deps: HandlerDeps,
  scope: string,
  label: string,
): Promise<CreateFreeResult> {
  const slot = await allocateFreeSlotPruned(deps);
  if (slot === null) return { status: "limit" };
  const sessionName = freeSessionName(deps.config.projectSessionPrefix, slot);
  try {
    await deps.bridge.createSession(sessionName);
    setFreeProject(slot, { label: label.trim() || null });
    await deps.currentProject.set(scope, sessionName);
    log.info("independent session created", {
      session: sessionName,
      data: { scope, slot },
    });
    return { status: "created", sessionName, slot };
  } catch (err) {
    return { status: "error", message: normalizeError(err).message };
  }
}

/**
 * Tear down a project session and every durable record keyed by its session name.
 * This is the lifecycle module's deletion interface: callers do not need to know
 * which registries exist or which order keeps reused independent slots clean.
 */
export async function removeProjectBySession(
  deps: HandlerDeps,
  sessionName: string,
): Promise<void> {
  const isRunning = await deps.agent.checkIfRunning(sessionName);

  deps.queue.clearSession(sessionName);

  if (isRunning) {
    await deps.bridge.sendExit(sessionName);
    let exited = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (!(await deps.agent.checkIfRunning(sessionName))) {
        exited = true;
        break;
      }
    }
    if (!exited) {
      await deps.bridge.sendRawKey("C-c", sessionName);
      await sleep(500);
    }
  }

  await deps.bridge.killSession(sessionName);
  cleanupSessionRecords(deps, sessionName);
  await deps.currentProject.clearSession(sessionName);

  const freeSlot = freeSlotOf(sessionName, deps.config.projectSessionPrefix);
  if (freeSlot !== null) cleanupIndependentSlot(sessionName, freeSlot);

  log.info("project session removed", {
    session: sessionName,
    data: { wasRunning: isRunning, ...(freeSlot !== null ? { freeSlot } : {}) },
  });
}

function cleanupSessionRecords(deps: HandlerDeps, sessionName: string): void {
  deps.configResolver.invalidate(sessionName);
  clearAgentRuntimeRecord(sessionName);
  clearTaskTiming(sessionName);
  clearPathForSession(sessionName);
  clearAutopilotState(sessionName);
  clearPicker(sessionName);
  markSessionStopped(sessionName);
  clearReplyTarget(sessionName);
}

function cleanupIndependentSlot(sessionName: string, freeSlot: number): void {
  const bound = bindingForSession(sessionName);
  if (bound) unbindGroup(bound.chatId);
  releaseFreeSlot(freeSlot);
}
