import { describe, expect, it } from "vitest";
import { createLarkRestoredMessage } from "../../../src/adapters/lark/executor.js";
import type { PersistedMessage } from "../../../src/core/command/queue.js";
import { fakeChannel } from "./_fakes.js";

// resolve/reject deliver via `void (async () => …)()`, so let microtasks drain.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const persisted: PersistedMessage = {
  id: "x",
  text: "do the thing",
  chatId: "oc_chat",
  channel: "lark",
  sessionName: "sess_a",
  action: "text",
};

describe("createLarkRestoredMessage (Lark queue restore on bot restart)", () => {
  it("rebuilds a Lark-channel QueuedMessage carrying the persisted fields", () => {
    const msg = createLarkRestoredMessage(persisted, fakeChannel());
    expect(msg).toMatchObject({
      id: "x",
      text: "do the thing",
      channel: "lark",
      sessionName: "sess_a",
      action: "text",
    });
  });

  it("delivers the recovered result through the channel on resolve", async () => {
    const channel = fakeChannel();
    createLarkRestoredMessage(persisted, channel).resolve("recovered output");
    await flush();
    expect(channel.cards()).toHaveLength(1);
  });

  it("delivers a recovery card on reject", async () => {
    const channel = fakeChannel();
    createLarkRestoredMessage(persisted, channel).reject(new Error("agent died"));
    await flush();
    expect(channel.cards()).toHaveLength(1);
  });
});
