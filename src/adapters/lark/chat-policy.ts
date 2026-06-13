import { isProjectGroup } from "../../core/group-bindings.js";

/**
 * Single source of truth for "where may a chat do what" on Feishu. The recurring
 * bug class here was a precondition enforced on one surface (typed command) but
 * forgotten on the other (card button), or on create-but-not-rebind. Both
 * surfaces now consult THIS table, so a rule is declared once and a new action
 * that isn't covered is caught by the policy-coverage test.
 */

/** A SERVICED chat: a 1:1 chat, or a bound project group. Unbound groups are
 *  dropped by the eligibility gate before any action runs, so they are never a
 *  valid kind here. */
export type ChatKind = "p2p" | "group";

/** Eligibility gate, shared by the text and card handlers: only 1:1 chats and
 *  bound project groups are serviced; an unbound group is ignored. */
export function serviceableChat(isP2p: boolean, chatId: string): boolean {
  return isP2p || isProjectGroup(chatId);
}

/** Project/group actions that carry a chat-type precondition. */
export type ProjectAction = "createGroup" | "bind" | "unbind" | "remove" | "switch" | "addRecent";

/** Static refusal message keys (the non-parameterised i18n entries). */
export type DenyMessageKey =
  | "groupNewGroupOnlyInP2p"
  | "groupBindOnlyInGroup"
  | "groupUnbindOnlyInGroup"
  | "groupNoRemoveInGroup";

/** How a disallowed action refuses: a static message, or the "pinned to this
 *  group's project" redirect (which needs the group label at render time). */
export type DenyReason = { kind: "message"; key: DenyMessageKey } | { kind: "pinned" };

interface Policy {
  readonly allowed: readonly ChatKind[];
  readonly deny: DenyReason;
}

export const ACTION_POLICY: Record<ProjectAction, Policy> = {
  createGroup: { allowed: ["p2p"], deny: { kind: "message", key: "groupNewGroupOnlyInP2p" } },
  bind: { allowed: ["group"], deny: { kind: "message", key: "groupBindOnlyInGroup" } },
  unbind: { allowed: ["group"], deny: { kind: "message", key: "groupUnbindOnlyInGroup" } },
  remove: { allowed: ["p2p"], deny: { kind: "message", key: "groupNoRemoveInGroup" } },
  // p2p-only; in a (pinned) group these redirect to rebind instead of acting.
  switch: { allowed: ["p2p"], deny: { kind: "pinned" } },
  addRecent: { allowed: ["p2p"], deny: { kind: "pinned" } },
};

/** Map a raw chat-type string (message `chatType`) to a serviced ChatKind. A
 *  serviced non-p2p chat is always a bound group (unbound ones are gated out). */
export function chatKindOf(chatType: string): ChatKind {
  return chatType === "p2p" ? "p2p" : "group";
}

/** Whether `action` is permitted in `kind`; on refusal, the reason to surface. */
export function checkAction(
  action: ProjectAction,
  kind: ChatKind,
): { ok: true } | { ok: false; deny: DenyReason } {
  const policy = ACTION_POLICY[action];
  return policy.allowed.includes(kind) ? { ok: true } : { ok: false, deny: policy.deny };
}
