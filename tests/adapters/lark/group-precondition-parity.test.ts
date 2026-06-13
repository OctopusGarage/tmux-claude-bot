import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCardActionHandler } from "../../../src/adapters/lark/card-actions.js";
import { handleBind, handleNewGroup } from "../../../src/adapters/lark/group-commands.js";
import { bindGroup, getBinding, unbindGroup } from "../../../src/core/group-bindings.js";
import { messages } from "../../../src/core/i18n/index.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

// createBoundChat hits the Lark API — stub it so "did we try to create a group?"
// is observable without a network call.
const createBoundChat = vi.fn();
vi.mock(import("../../../src/adapters/lark/resource.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBoundChat: (...args: unknown[]) => createBoundChat(...args) };
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

const m = messages("lark");

/**
 * Chat-type precondition PARITY between the two surfaces. Project/group mutations
 * are reachable two ways — a typed command (handlers) and a card button
 * (card-actions). The recurring bug class in this codebase is one surface
 * enforcing a precondition the other forgot (the card path skipped the p2p/group
 * check the text path had). These tests pin the two surfaces to the SAME verdict
 * and the SAME message, so re-divergence fails loudly.
 */
describe("group-op precondition parity (card surface == text surface)", () => {
  afterEach(() => {
    for (const { chatId } of [{ chatId: "chat-1" }]) unbindGroup(chatId);
    vi.clearAllMocks();
  });

  it("creating a group is private-chat only on BOTH surfaces (refused in a group, same message)", async () => {
    // text surface: /newgroup in a group
    const tChannel = fakeChannel();
    await handleNewGroup(tChannel, fakeDeps(), "oc_grp", "group", "ou_me", "/some/path");

    // card surface: makegroup tapped in a bound group
    bindGroup("chat-1", { workspacePath: "/p", sessionName: "s", label: "L" });
    const cChannel = fakeChannel();
    await makeCardActionHandler(cChannel, fakeDeps())(evt({ cmd: "makegroup", sid: "x" }));

    // same verdict + same message on both surfaces
    expect(tChannel.texts()).toContain(m.groupNewGroupOnlyInP2p);
    expect(cChannel.texts()).toContain(m.groupNewGroupOnlyInP2p);
    expect(createBoundChat).not.toHaveBeenCalled(); // neither surface created a group
  });

  it("binding the current chat is group-only on BOTH surfaces (refused in p2p, same message)", async () => {
    // text surface: /bind in a private chat
    const tChannel = fakeChannel();
    await handleBind(tChannel, fakeDeps(), "ou_me", "p2p", "/some/path");

    // card surface: bindhere tapped in a private chat (chat-1, unbound → p2p)
    const cChannel = fakeChannel(); // default chat type p2p
    await makeCardActionHandler(cChannel, fakeDeps())(evt({ cmd: "bindhere", sid: "x" }));

    // same verdict + same message on both surfaces
    expect(tChannel.texts()).toContain(m.groupBindOnlyInGroup);
    expect(cChannel.texts()).toContain(m.groupBindOnlyInGroup);
    expect(getBinding("chat-1")).toBeNull(); // card surface wrote no p2p binding
  });
});
