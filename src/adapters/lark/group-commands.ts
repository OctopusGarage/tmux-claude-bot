import { basename } from "node:path";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { reconcileGroupBinding, resolveWorkspaceTarget } from "../../core/group-binding-ops.js";
import {
  bindGroup,
  bindingForSession,
  getBinding,
  unbindGroup,
} from "../../core/group-bindings.js";
import { messages } from "../../core/i18n/index.js";
import { chatScope } from "../../core/project-manager.js";
import { createProjectSession } from "../../core/project-ops.js";
import { readRecentProjectLines } from "../../core/recentProjects.js";
import { sessionNameFromPath } from "../../core/sessionPathMap.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { logger } from "../../shared/utils/logger.js";
import { sendText } from "./replies.js";
import { createBoundChat } from "./resource.js";

const m = () => messages("lark");

/** Resolve a recent-project short id back to its absolute path (mirrors the
 * recent-list create button's resolution). */
async function recentPathByShortId(deps: HandlerDeps, sid: string): Promise<string | null> {
  const prefix = deps.config.projectSessionPrefix;
  const lines = await readRecentProjectLines();
  return lines.find((p) => sessionShortId(sessionNameFromPath(p, prefix)) === sid) ?? null;
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
    logger.warn("[lark] makegroup with no lark config (unreachable)");
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
  await sendText(channel, created.chatId, m().groupBoundWelcome(label, path));
  await sendText(channel, originChatId, m().groupCreatedShort(label));
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
  bindGroup(chatId, { workspacePath: path, sessionName, label });
  await createProjectSession(deps, chatScope("lark", chatId), sessionName, path);
  await sendText(channel, chatId, m().groupBoundWelcome(label, path));
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
  if (chatType !== "p2p") {
    await sendText(channel, chatId, m().groupNewGroupOnlyInP2p);
    return;
  }
  const target = await resolveOrReply(channel, deps, chatId, arg);
  if (!target) return;
  if (!deps.config.lark) {
    logger.warn("[lark] /newgroup with no lark config (unreachable)");
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
  await sendText(
    channel,
    created.chatId,
    m().groupBoundWelcome(target.label, target.workspacePath),
  );
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
  if (chatType === "p2p") {
    await sendText(channel, chatId, m().groupBindOnlyInGroup);
    return;
  }
  const target = await resolveOrReply(channel, deps, chatId, arg);
  if (!target) return;

  bindGroup(chatId, target);
  await createProjectSession(
    deps,
    chatScope("lark", chatId),
    target.sessionName,
    target.workspacePath,
  );
  await sendText(channel, chatId, m().groupBoundWelcome(target.label, target.workspacePath));
}

/** `/unbind` — inside a group only. */
export async function handleUnbind(
  channel: LarkChannel,
  _deps: HandlerDeps,
  chatId: string,
  chatType: string,
): Promise<void> {
  if (chatType === "p2p") {
    await sendText(channel, chatId, m().groupUnbindOnlyInGroup);
    return;
  }
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
  logger.info(`[lark] /restore chat=${chatId} status=${r.status}`);
}
