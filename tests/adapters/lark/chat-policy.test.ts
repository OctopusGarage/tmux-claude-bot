import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCardActionHandler } from "../../../src/adapters/lark/card-actions.js";
import {
  ACTION_POLICY,
  type ChatKind,
  type ProjectAction,
} from "../../../src/adapters/lark/chat-policy.js";
import { bindGroup, unbindGroup } from "../../../src/core/group-bindings.js";
import { messages } from "../../../src/core/i18n/index.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

vi.mock(import("../../../src/adapters/lark/resource.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBoundChat: vi.fn(async () => ({ chatId: "oc_x", name: "x" })) };
});

function evt(value: unknown, over: Partial<CardActionEvent> = {}): CardActionEvent {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    operator: { openId: "ou_me" },
    action: { value, tag: "button" },
    ...over,
  } as CardActionEvent;
}

/** The card button cmd that triggers each policed action. A `Record` over
 *  ProjectAction, so a NEW action added to ACTION_POLICY fails to compile until
 *  its card surface is declared here — that's the coverage guarantee. */
const CARD_CMD: Record<ProjectAction, string> = {
  createGroup: "makegroup",
  bind: "bindhere",
  unbind: "unbind",
  remove: "remove",
  switch: "switch",
  addRecent: "addrecent",
};

const m = messages("lark");
const ALL = Object.keys(ACTION_POLICY) as ProjectAction[];

describe("chat-policy table", () => {
  it("every action declares a non-empty allowed set within {p2p, group}", () => {
    for (const action of ALL) {
      const allowed = ACTION_POLICY[action].allowed;
      expect(allowed.length, action).toBeGreaterThan(0);
      for (const k of allowed) expect(["p2p", "group"]).toContain(k);
    }
  });
});

describe("card surface enforces ACTION_POLICY for every action (coverage)", () => {
  afterEach(() => {
    unbindGroup("oc_policy");
    vi.clearAllMocks();
  });

  for (const action of ALL) {
    it(`refuses '${action}' in a disallowed chat kind, with the policy's message`, async () => {
      const policy = ACTION_POLICY[action];
      const disallowed = (["p2p", "group"] as ChatKind[]).find((k) => !policy.allowed.includes(k));
      // Skip the (currently nonexistent) any-chat action — nothing to refuse.
      if (!disallowed) return;

      const chatId = "oc_policy";
      const channel = fakeChannel();
      // Realise the disallowed kind: a bound chat reads as "group"; an unbound
      // one (default getChatInfo) reads as "p2p".
      if (disallowed === "group") {
        bindGroup(chatId, { workspacePath: "/p", sessionName: "s", label: "L" });
      }

      const handler = makeCardActionHandler(channel, fakeDeps());
      await handler(evt({ cmd: CARD_CMD[action], sid: "x" }, { chatId }));

      const expected =
        policy.deny.kind === "pinned" ? m.groupPinnedNoSwitch("L") : m[policy.deny.key];
      expect(channel.texts(), `${action} should refuse in ${disallowed}`).toContain(expected);
    });
  }
});
