import { basename } from "node:path";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import {
  FREE_PROJECT_LIMIT,
  freeSessionName,
  freeSlotOf,
  getFreeProject,
  setFreeProject,
} from "../../core/projects/free-projects.js";
import {
  reconcileGroupBinding,
  resolveWorkspaceTarget,
} from "../../core/projects/group-binding-ops.js";
import {
  bindGroup,
  bindingForSession,
  type GroupBinding,
  getBinding,
  listBindings,
  unbindGroup,
} from "../../core/projects/group-bindings.js";
import { chatScope } from "../../core/projects/project-manager.js";
import {
  allocateFreeSlotPruned,
  createProjectSession,
  resolveAliveSessionByShortId,
  resolveProjectPathByShortId,
} from "../../core/projects/project-ops.js";
import { getPathBySession, sessionNameFromPath } from "../../core/projects/sessionPathMap.js";
import { isPromptTranslateInstallable } from "../../core/read/prompt-translation.js";
import { isVoiceInstallable } from "../../core/read/voice-support.js";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { helpCard } from "./cards.js";
import { chatKindOf, checkAction, type ProjectAction } from "./chat-policy.js";
import { sendCard, sendText } from "./replies.js";
import { createBoundChat } from "./resource.js";

const log = createLogger("lark.group-commands");

const m = () => messages("lark");

/** After a successful bind/create: confirm the binding, then drop the full group
 * home menu (work-surface shortcuts — peek / history / queue / controls — plus
 * binding management) so the user can act immediately, instead of getting only an
 * unbind button. Used by EVERY bind/create path for a consistent welcome. */
async function sendGroupHome(
  channel: LarkChannel,
  chatId: string,
  label: string,
  path: string,
): Promise<void> {
  await sendText(channel, chatId, m().groupBoundWelcome(label, path));
  await sendCard(
    channel,
    chatId,
    helpCard(true, isVoiceInstallable(), isPromptTranslateInstallable()),
  );
}

/** Enforce the shared chat-type policy (chat-policy.ts) for a typed command:
 *  reply with the policy's refusal and return true when denied. Keeps the text
 *  surface in lock-step with the card surface — both read ACTION_POLICY. */
async function deniedByPolicy(
  channel: LarkChannel,
  chatId: string,
  action: ProjectAction,
  chatType: string,
): Promise<boolean> {
  const verdict = checkAction(action, chatKindOf(chatType));
  if (verdict.ok) return false;
  const text =
    verdict.deny.kind === "pinned"
      ? m().groupPinnedNoSwitch(getBinding(chatId)?.label ?? "")
      : m()[verdict.deny.key];
  await sendText(channel, chatId, text);
  return true;
}

async function createBoundChatOrReply(
  channel: LarkChannel,
  lark: NonNullable<HandlerDeps["config"]["lark"]>,
  originChatId: string,
  name: string,
  inviteOpenId: string,
): Promise<{ chatId: string; name: string } | null> {
  try {
    return await createBoundChat(lark, { name, inviteOpenId });
  } catch (err) {
    await sendText(
      channel,
      originChatId,
      m().groupCreateFailed(err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/** Resolve a picked project's short id back to its absolute path, over the same
 * set the picker shows (recents ∪ live tmux) so a live project absent from the
 * recents file still resolves (otherwise "Short id not found"). */
async function recentPathByShortId(deps: HandlerDeps, sid: string): Promise<string | null> {
  return resolveProjectPathByShortId(deps, sid);
}

/** The OTHER group already bound to `sessionName` (excluding `chatId`), if any.
 * Enforces one workspace ↔ one group on the (re)bind paths while still letting a
 * group re-anchor to its OWN project. */
function otherGroupForSession(
  sessionName: string,
  chatId: string,
): { chatId: string; binding: GroupBinding } | null {
  const existing = bindingForSession(sessionName);
  return existing && existing.chatId !== chatId ? existing : null;
}

/** Button-driven `/newgroup`: create a bound group for the picked recent project
 * (private chat). No typing — the project comes from a tapped short id. */
export async function makeBoundGroupBySid(
  channel: LarkChannel,
  deps: HandlerDeps,
  originChatId: string,
  sid: string,
  inviteOpenId: string,
): Promise<void> {
  if (!deps.config.lark) {
    log.warn("makegroup with no lark config (unreachable)");
    return;
  }
  const path = await recentPathByShortId(deps, sid);
  if (!path) {
    await sendText(channel, originChatId, m().shortIdNotFound(sid));
    return;
  }
  const label = basename(path);
  const sessionName = sessionNameFromPath(path, deps.config.projectSessionPrefix);

  // One workspace ↔ one group: refuse if a LIVE group already owns this project;
  // a stale binding (its group was disbanded) is auto-cleared so rebuild proceeds.
  const blocking = await blockingBindingFor(channel, sessionName);
  if (blocking) {
    await sendText(channel, originChatId, m().groupAlreadyExists(blocking.binding.label));
    return;
  }

  const created = await createBoundChatOrReply(
    channel,
    deps.config.lark,
    originChatId,
    label,
    inviteOpenId,
  );
  if (!created) return;

  bindGroup(created.chatId, { workspacePath: path, sessionName, label });
  await createProjectSession(deps, chatScope("lark", created.chatId), sessionName, path);
  await sendGroupHome(channel, created.chatId, label, path);
  await sendText(channel, originChatId, m().groupCreatedShort(label));
}

/** Shared core: create a NEW group bound to a FRESH independent session on `path`, so the
 * same dir can host multiple parallel project groups/agents. Unlike makeBoundGroupBySid it
 * never refuses on an existing binding (distinct independent session = distinct workspace
 * key). Backs both the button (sid) and the `/newfreegroup <path>` command. */
async function createFreeGroupAtPath(
  channel: LarkChannel,
  deps: HandlerDeps,
  originChatId: string,
  path: string,
  inviteOpenId: string,
): Promise<void> {
  if (!deps.config.lark) {
    log.warn("parallel group with no lark config (unreachable)");
    return;
  }
  const slot = await allocateFreeSlotPruned(deps);
  if (slot === null) {
    await sendText(channel, originChatId, m().freeProjectLimit(FREE_PROJECT_LIMIT));
    return;
  }
  const sessionName = freeSessionName(deps.config.projectSessionPrefix, slot);
  // Parallel index: number of groups already on this dir + 1 (the first is "#1").
  const k = listBindings().filter(({ binding }) => binding.workspacePath === path).length + 1;
  const label = `${basename(path)} #${k}`;

  const created = await createBoundChatOrReply(
    channel,
    deps.config.lark,
    originChatId,
    label,
    inviteOpenId,
  );
  if (!created) return;

  // Persist the binding + slot BEFORE creating the session (mirrors handleNewGroup):
  // if createProjectSession then fails, the dangling binding self-heals on the
  // group's next message via reconcile, and the slot stays reserved because the
  // group owns it (allocateFreeSlotPruned keeps bound-but-dead slots).
  bindGroup(created.chatId, { workspacePath: path, sessionName, label });
  setFreeProject(slot, { label });
  await createProjectSession(deps, chatScope("lark", created.chatId), sessionName, path);
  await sendGroupHome(channel, created.chatId, label, path);
  await sendText(channel, originChatId, m().freeGroupCreated(label));
}

/** Button-driven "parallel project group": resolve a recent project's short id to its
 * path, then create an independent-session group there. Private chat only
 * (gated by the card action). */
export async function makeFreeGroupBySid(
  channel: LarkChannel,
  deps: HandlerDeps,
  originChatId: string,
  sid: string,
  inviteOpenId: string,
): Promise<void> {
  const path = await recentPathByShortId(deps, sid);
  if (!path) {
    await sendText(channel, originChatId, m().shortIdNotFound(sid));
    return;
  }
  await createFreeGroupAtPath(channel, deps, originChatId, path, inviteOpenId);
}

/** Button from the live-project list for an EXISTING independent session: create a Lark
 * group bound to that already-running session. This is intentionally NOT
 * the same as makeFreeGroupBySid/newfreegroup, which allocate a fresh independent-session slot
 * and create a new project session. */
export async function makeExistingFreeGroupBySid(
  channel: LarkChannel,
  deps: HandlerDeps,
  originChatId: string,
  sid: string,
  inviteOpenId: string,
): Promise<void> {
  if (!deps.config.lark) {
    log.warn("existing independent-session group with no lark config (unreachable)");
    return;
  }
  const sessionName = await resolveAliveSessionByShortId(deps, sid);
  const slot = sessionName ? freeSlotOf(sessionName, deps.config.projectSessionPrefix) : null;
  const path = sessionName ? getPathBySession(sessionName) : null;
  if (!sessionName || slot === null || !path) {
    await sendText(channel, originChatId, m().shortIdNotFound(sid));
    return;
  }
  const existing = bindingForSession(sessionName);
  if (existing) {
    await sendText(channel, originChatId, m().groupAlreadyExists(existing.binding.label));
    return;
  }
  const label = getFreeProject(slot)?.label?.trim() || `${basename(path)} #${slot}`;

  const created = await createBoundChatOrReply(
    channel,
    deps.config.lark,
    originChatId,
    label,
    inviteOpenId,
  );
  if (!created) return;

  bindGroup(created.chatId, { workspacePath: path, sessionName, label });
  await deps.currentProject.set(chatScope("lark", created.chatId), sessionName);
  await sendGroupHome(channel, created.chatId, label, path);
  await sendText(channel, originChatId, m().groupCreatedShort(label));
}

/** `/newfreegroup <path|name>` — private chat only. The typed-path counterpart of
 * the independent-session button: create a parallel project group on ANY allowed directory (not just
 * recents). Mirrors handleNewGroup's validation. */
export async function handleNewFreeGroup(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  chatType: string,
  senderId: string,
  arg: string | undefined,
): Promise<void> {
  if (await deniedByPolicy(channel, chatId, "createGroup", chatType)) return;
  const target = await resolveOrReply(channel, deps, chatId, arg);
  if (!target) return;
  await createFreeGroupAtPath(channel, deps, chatId, target.workspacePath, senderId);
}

/** Button-driven `/bind` (and rebind): bind the CURRENT group to a picked recent
 * project. Used in a group. */
export async function bindCurrentGroupBySid(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  sid: string,
): Promise<void> {
  const path = await recentPathByShortId(deps, sid);
  if (!path) {
    await sendText(channel, chatId, m().shortIdNotFound(sid));
    return;
  }
  const label = basename(path);
  const sessionName = sessionNameFromPath(path, deps.config.projectSessionPrefix);
  const blocking = await blockingBindingFor(channel, sessionName, chatId);
  if (blocking) {
    await sendText(channel, chatId, m().groupAlreadyExists(blocking.binding.label));
    return;
  }
  bindGroup(chatId, { workspacePath: path, sessionName, label });
  await createProjectSession(deps, chatScope("lark", chatId), sessionName, path);
  await sendGroupHome(channel, chatId, label, path);
}

/** Validate the arg, return the resolved target, or reply an error + return null. */
async function resolveOrReply(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  arg: string | undefined,
): Promise<{ workspacePath: string; sessionName: string; label: string } | null> {
  if (!arg) {
    await sendText(channel, chatId, m().groupTargetUsage);
    return null;
  }
  const res = await resolveWorkspaceTarget(deps, arg);
  if ("error" in res) {
    await sendText(
      channel,
      chatId,
      `❌ ${res.error}${res.resolvedPath ? `: ${res.resolvedPath}` : ""}`,
    );
    return null;
  }
  return res;
}

/** `/newgroup <path|name>` — private chat only. */
export async function handleNewGroup(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  chatType: string,
  senderId: string,
  arg: string | undefined,
): Promise<void> {
  if (await deniedByPolicy(channel, chatId, "createGroup", chatType)) return;
  const target = await resolveOrReply(channel, deps, chatId, arg);
  if (!target) return;
  if (!deps.config.lark) {
    log.warn("/newgroup with no lark config (unreachable)");
    return;
  }

  // One workspace ↔ one group: refuse only if a LIVE group owns this project;
  // a disbanded group's stale binding is auto-cleared so rebuild proceeds.
  const blocking = await blockingBindingFor(channel, target.sessionName);
  if (blocking) {
    await sendText(channel, chatId, m().groupAlreadyExists(blocking.binding.label));
    return;
  }

  const created = await createBoundChatOrReply(
    channel,
    deps.config.lark,
    chatId,
    target.label,
    senderId,
  );
  if (!created) return;

  // Persist the binding BEFORE creating the session: the group gate ignores
  // unbound groups, so a dangling binding (no session yet) self-heals on the
  // next message via reconcile, whereas an orphan group with no binding is a
  // dead end. Mirrors handleBind's order.
  bindGroup(created.chatId, target);
  await createProjectSession(
    deps,
    chatScope("lark", created.chatId),
    target.sessionName,
    target.workspacePath,
  );
  await sendGroupHome(channel, created.chatId, target.label, target.workspacePath);
  // Confirm back in the originating private chat too.
  await sendText(channel, chatId, m().groupBoundWelcome(target.label, target.workspacePath));
}

/** `/bind` and `/rebind` — inside a group only. */
export async function handleBind(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  chatType: string,
  arg: string | undefined,
): Promise<void> {
  if (await deniedByPolicy(channel, chatId, "bind", chatType)) return;
  const target = await resolveOrReply(channel, deps, chatId, arg);
  if (!target) return;

  const other = otherGroupForSession(target.sessionName, chatId);
  if (other) {
    await sendText(channel, chatId, m().groupAlreadyExists(other.binding.label));
    return;
  }

  bindGroup(chatId, target);
  await createProjectSession(
    deps,
    chatScope("lark", chatId),
    target.sessionName,
    target.workspacePath,
  );
  await sendGroupHome(channel, chatId, target.label, target.workspacePath);
}

/** `/unbind` — inside a group only. */
export async function handleUnbind(
  channel: LarkChannel,
  _deps: HandlerDeps,
  chatId: string,
  chatType: string,
): Promise<void> {
  if (await deniedByPolicy(channel, chatId, "unbind", chatType)) return;
  await sendText(channel, chatId, unbindGroup(chatId) ? m().groupUnbound : m().groupNotBound);
}

/** Clear a group's binding (its chat is gone / being abandoned), so the stale
 * record can't block rebuilding a group for the same project. */
function forgetBinding(chatId: string, reason: string): void {
  const binding = getBinding(chatId);
  if (!binding) return;
  unbindGroup(chatId);
  log.info(`group binding cleared (${reason}) chat=${chatId} label=${binding.label}`);
}

/** Whether a previously-bound group chat is still live (the bot can still read it).
 * getChatInfo fails for a disbanded chat. Retries once so a transient API blip
 * can't wrongly report "gone" and clear a healthy binding. */
async function boundGroupStillLive(channel: LarkChannel, chatId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await channel.getChatInfo(chatId);
      return true;
    } catch (err) {
      log.warn("getChatInfo failed for bound chat", {
        chatId,
        data: { attempt: attempt + 1 },
        err,
      });
      if (attempt === 0) await sleep(500);
    }
  }
  return false;
}

/**
 * The existing binding that should BLOCK creating a new group for `sessionName`
 * (one workspace ↔ one group). Returns the binding only if its group is still
 * live; if the group was disbanded, auto-clears the stale binding and returns null
 * so the rebuild proceeds. Pass `excludeChatId` on the (re)bind path so a group can
 * re-anchor to its own project.
 */
async function blockingBindingFor(
  channel: LarkChannel,
  sessionName: string,
  excludeChatId?: string,
): Promise<{ chatId: string; binding: GroupBinding } | null> {
  const existing = excludeChatId
    ? otherGroupForSession(sessionName, excludeChatId)
    : bindingForSession(sessionName);
  if (!existing) return null;
  if (await boundGroupStillLive(channel, existing.chatId)) return existing;
  forgetBinding(existing.chatId, "disbanded — detected at rebuild");
  return null;
}

/** `/restore` — re-anchor this group to its binding. */
export async function handleRestore(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const binding = getBinding(chatId);
  if (!binding) {
    await sendText(channel, chatId, m().groupNotBound);
    return;
  }
  const r = await reconcileGroupBinding(deps, "lark", chatId);
  if (r.status === "missing-path") {
    await sendText(channel, chatId, m().groupMissingPath(r.label));
  } else {
    await sendText(channel, chatId, m().groupRestored(binding.label));
  }
  log.info(`/restore chat=${chatId} status=${r.status}`);
}
