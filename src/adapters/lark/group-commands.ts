import { basename } from "node:path";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import {
  FREE_PROJECT_LIMIT,
  freeSessionName,
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
import { allocateFreeSlotPruned, createProjectSession } from "../../core/projects/project-ops.js";
import { readRecentProjectLines } from "../../core/projects/recentProjects.js";
import { sessionNameFromPath } from "../../core/projects/sessionPathMap.js";
import { isVoiceInstallable } from "../../core/read/voice-support.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { createLogger } from "../../shared/utils/logger.js";
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
  await sendCard(channel, chatId, helpCard(true, isVoiceInstallable()));
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

/** Resolve a recent-project short id back to its absolute path (mirrors the
 * recent-list create button's resolution). */
async function recentPathByShortId(deps: HandlerDeps, sid: string): Promise<string | null> {
  const prefix = deps.config.projectSessionPrefix;
  const lines = await readRecentProjectLines();
  return lines.find((p) => sessionShortId(sessionNameFromPath(p, prefix)) === sid) ?? null;
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

  // One workspace ↔ one group: don't create a second group for a project that
  // already has one.
  const existing = bindingForSession(sessionName);
  if (existing) {
    await sendText(channel, originChatId, m().groupAlreadyExists(existing.binding.label));
    return;
  }

  let created: { chatId: string; name: string };
  try {
    created = await createBoundChat(deps.config.lark, { name: label, inviteOpenId });
  } catch (err) {
    await sendText(
      channel,
      originChatId,
      m().groupCreateFailed(err instanceof Error ? err.message : String(err)),
    );
    return;
  }

  bindGroup(created.chatId, { workspacePath: path, sessionName, label });
  await createProjectSession(deps, chatScope("lark", created.chatId), sessionName, path);
  await sendGroupHome(channel, created.chatId, label, path);
  await sendText(channel, originChatId, m().groupCreatedShort(label));
}

/** Shared core: create a NEW group bound to a FRESH free session on `path`, so the
 * same dir can host multiple parallel groups/Claudes. Unlike makeBoundGroupBySid it
 * never refuses on an existing binding (distinct free session = distinct workspace
 * key). Backs both the button (sid) and the `/newfreegroup <path>` command. */
async function createFreeGroupAtPath(
  channel: LarkChannel,
  deps: HandlerDeps,
  originChatId: string,
  path: string,
  inviteOpenId: string,
): Promise<void> {
  if (!deps.config.lark) {
    log.warn("free group with no lark config (unreachable)");
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

  let created: { chatId: string; name: string };
  try {
    created = await createBoundChat(deps.config.lark, { name: label, inviteOpenId });
  } catch (err) {
    await sendText(
      channel,
      originChatId,
      m().groupCreateFailed(err instanceof Error ? err.message : String(err)),
    );
    return;
  }

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

/** Button-driven "free parallel group": resolve a recent project's short id to its
 * path, then create a free parallel group there. Private chat only (gated by the
 * card action). */
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

/** `/newfreegroup <path|name>` — private chat only. The typed-path counterpart of
 * the 🆓 button: create a free parallel group on ANY allowed directory (not just
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
  const other = otherGroupForSession(sessionName, chatId);
  if (other) {
    await sendText(channel, chatId, m().groupAlreadyExists(other.binding.label));
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

  // One workspace ↔ one group: don't create a second group for a project that
  // already has one.
  const existing = bindingForSession(target.sessionName);
  if (existing) {
    await sendText(channel, chatId, m().groupAlreadyExists(existing.binding.label));
    return;
  }

  let created: { chatId: string; name: string };
  try {
    created = await createBoundChat(deps.config.lark, {
      name: target.label,
      inviteOpenId: senderId,
    });
  } catch (err) {
    await sendText(
      channel,
      chatId,
      m().groupCreateFailed(err instanceof Error ? err.message : String(err)),
    );
    return;
  }

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
