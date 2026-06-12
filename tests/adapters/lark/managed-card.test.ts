import { describe, expect, it, vi } from "vitest";
import { sendManagedCard, updateManagedCard } from "../../../src/adapters/lark/managed-card.js";
import { fakeChannel } from "./_fakes.js";

/**
 * Managed cards: a CardKit 2.0 card entity is created first, then a message
 * references it by card_id. Updates go through cardkit card.update with an
 * auto-incremented sequence, so they can't be reordered or rejected — the
 * documented failure mode of plain `updateCard` on 2.0 cards.
 */
describe("sendManagedCard", () => {
  it("creates a card entity and sends a message referencing it", async () => {
    const channel = fakeChannel();
    const card = { schema: "2.0", body: { elements: [] } };

    const messageId = await sendManagedCard(channel, "oc_chat", card);

    expect(channel.cardkitCreates).toEqual([
      { data: { type: "card_json", data: JSON.stringify(card) } },
    ]);
    expect(channel.imCreates).toEqual([
      {
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat",
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: "card1" } }),
        },
      },
    ]);
    expect(messageId).toBe("im-m1");
  });

  it("falls back to a plain card send when entity creation fails", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.rawClient.cardkit.v1.card.create).mockResolvedValueOnce({
      code: 230001,
      msg: "boom",
    });

    const messageId = await sendManagedCard(channel, "oc_chat", { v: 1 });

    expect(channel.cards()).toEqual([{ v: 1 }]);
    expect(messageId).toBe("m1");
    // The fallback message carries no entity, so it is not updatable.
    expect(await updateManagedCard(channel, "m1", { v: 2 })).toBe(false);
  });

  it("falls back to a plain card send when the cardkit API throws", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.rawClient.cardkit.v1.card.create).mockRejectedValueOnce(
      new Error("network down"),
    );

    const messageId = await sendManagedCard(channel, "oc_chat", { v: 1 });

    expect(channel.cards()).toEqual([{ v: 1 }]);
    expect(messageId).toBe("m1");
  });

  it("falls back to a plain card send when the message send fails", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.rawClient.im.v1.message.create).mockResolvedValueOnce({
      code: 230002,
      msg: "no perm",
    });

    const messageId = await sendManagedCard(channel, "oc_chat", { v: 1 });

    expect(channel.cards()).toEqual([{ v: 1 }]);
    expect(messageId).toBe("m1");
  });
});

describe("updateManagedCard", () => {
  it("updates the entity in place with an auto-incrementing sequence", async () => {
    const channel = fakeChannel();
    const messageId = await sendManagedCard(channel, "oc_chat", { v: 1 });

    expect(await updateManagedCard(channel, messageId as string, { v: 2 })).toBe(true);
    expect(await updateManagedCard(channel, messageId as string, { v: 3 })).toBe(true);

    expect(channel.cardkitUpdates.map((u) => u.data.sequence)).toEqual([1, 2]);
    expect(channel.cardkitUpdates.map((u) => u.path.card_id)).toEqual(["card1", "card1"]);
    expect(channel.cardkitUpdates.map((u) => u.data.card)).toEqual([
      { type: "card_json", data: JSON.stringify({ v: 2 }) },
      { type: "card_json", data: JSON.stringify({ v: 3 }) },
    ]);
    // No new message was sent — the existing one was updated.
    expect(channel.sent).toHaveLength(0);
    expect(channel.imCreates).toHaveLength(1);
  });

  it("returns false for a message it does not manage", async () => {
    const channel = fakeChannel();
    expect(await updateManagedCard(channel, "im-m-unknown", { v: 1 })).toBe(false);
    expect(channel.cardkitUpdates).toHaveLength(0);
  });

  it("returns false when the update API rejects the change", async () => {
    const channel = fakeChannel();
    const messageId = await sendManagedCard(channel, "oc_chat", { v: 1 });
    vi.mocked(channel.rawClient.cardkit.v1.card.update).mockResolvedValueOnce({
      code: 230099,
      msg: "element exceeds the limit",
    });

    expect(await updateManagedCard(channel, messageId as string, { v: 2 })).toBe(false);
  });

  it("returns false when the update API throws", async () => {
    const channel = fakeChannel();
    const messageId = await sendManagedCard(channel, "oc_chat", { v: 1 });
    vi.mocked(channel.rawClient.cardkit.v1.card.update).mockRejectedValueOnce(
      new Error("network down"),
    );

    expect(await updateManagedCard(channel, messageId as string, { v: 2 })).toBe(false);
  });
});
