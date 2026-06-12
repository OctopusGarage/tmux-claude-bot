import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { reconcileGroupBinding, resolveWorkspaceTarget } from "../../core/group-binding-ops.js";
import { bindGroup, getBinding, unbindGroup } from "../../core/group-bindings.js";
import { messages } from "../../core/i18n/index.js";
import { chatScope } from "../../core/project-manager.js";
import { createProjectSession } from "../../core/project-ops.js";
import { logger } from "../../shared/utils/logger.js";
import { sendText } from "./replies.js";
import { createBoundChat } from "./resource.js";

const m = () => messages("lark");

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
  if (!deps.config.lark) return;

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
    await sendText(channel, chatId, m().groupBindOnlyInGroup);
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
  const r = await reconcileGroupBinding(deps, chatId);
  if (r.status === "missing-path") {
    await sendText(channel, chatId, m().groupMissingPath(r.label));
  } else {
    await sendText(channel, chatId, m().groupRestored(binding.label));
  }
  logger.info(`[lark] /restore chat=${chatId} status=${r.status}`);
}
