import { describe, expect, it } from "vitest";
import type { PersistedMessage, QueuedMessage } from "../../src/core/command/queue.js";
import { restorePersistedChannel } from "../../src/core/command/queue-restore.js";

function persisted(id: string, channel: PersistedMessage["channel"]): PersistedMessage {
  return {
    id,
    text: `text-${id}`,
    chatId: "chat",
    channel,
    sessionName: "session",
    action: "text",
  };
}

function queued(message: PersistedMessage): QueuedMessage {
  return {
    ...message,
    channel: message.channel,
    resolve: () => {},
    reject: () => {},
  };
}

describe("restorePersistedChannel", () => {
  it("does not require a carryover write when there is no persisted backlog", () => {
    const summary = restorePersistedChannel({
      channel: "telegram",
      loadPersisted: () => [],
      enqueue: () => {
        throw new Error("should not enqueue");
      },
      keepPersistedCarryover: () => {
        throw new Error("should not write carryover");
      },
      restore: queued,
    });

    expect(summary).toEqual({ restored: 0, carriedOver: 0, skipped: 0 });
  });

  it("restores only the selected channel and carries over non-owned messages", () => {
    const enqueued: string[] = [];
    const kept: string[][] = [];

    const summary = restorePersistedChannel({
      channel: "lark",
      loadPersisted: () => [
        persisted("telegram", "telegram"),
        persisted("lark", "lark"),
        persisted("control", "control"),
      ],
      enqueue: (message) => {
        enqueued.push(message.id);
        return "queued";
      },
      keepPersistedCarryover: (messages) => kept.push(messages.map((message) => message.id)),
      restore: queued,
    });

    expect(summary).toEqual({ restored: 1, carriedOver: 2, skipped: 0 });
    expect(enqueued).toEqual(["lark"]);
    expect(kept).toEqual([["telegram", "control"]]);
  });

  it("carries over selected-channel messages that cannot be re-enqueued", () => {
    const summary = restorePersistedChannel({
      channel: "control",
      loadPersisted: () => [persisted("queued", "control"), persisted("blocked", "control")],
      enqueue: (message) => (message.id === "queued" ? "queued" : false),
      keepPersistedCarryover: (messages) => {
        expect(messages.map((message) => message.id)).toEqual(["blocked"]);
      },
      restore: queued,
    });

    expect(summary).toEqual({ restored: 1, carriedOver: 1, skipped: 0 });
  });

  it("treats legacy messages without a channel as telegram-owned", () => {
    const legacy = persisted("legacy", undefined);
    const lark = persisted("lark", "lark");
    const kept: string[][] = [];

    const summary = restorePersistedChannel({
      channel: "telegram",
      loadPersisted: () => [legacy, lark],
      enqueue: () => "queued",
      keepPersistedCarryover: (messages) => kept.push(messages.map((message) => message.id)),
      restore: queued,
    });

    expect(summary).toEqual({ restored: 1, carriedOver: 1, skipped: 0 });
    expect(kept).toEqual([["lark"]]);
  });

  it("can skip malformed selected-channel messages without counting them as restored", () => {
    const summary = restorePersistedChannel({
      channel: "control",
      loadPersisted: () => [persisted("bad", "control")],
      enqueue: () => {
        throw new Error("should not enqueue skipped work");
      },
      keepPersistedCarryover: (messages) => {
        expect(messages.map((message) => message.id)).toEqual(["bad"]);
      },
      restore: () => null,
    });

    expect(summary).toEqual({ restored: 0, carriedOver: 1, skipped: 1 });
  });

  it("does not re-enqueue selected-channel messages that were already dispatched", () => {
    const alreadyDispatched = {
      ...persisted("typed-before-restart", "lark"),
      dispatched: true,
    };
    const waiting = persisted("still-waiting", "lark");
    const enqueued: string[] = [];

    const summary = restorePersistedChannel({
      channel: "lark",
      loadPersisted: () => [alreadyDispatched, waiting],
      enqueue: (message) => {
        enqueued.push(message.id);
        return "queued";
      },
      keepPersistedCarryover: (messages) => {
        expect(messages).toEqual([]);
      },
      restore: queued,
    });

    expect(summary).toEqual({ restored: 1, carriedOver: 0, skipped: 1 });
    expect(enqueued).toEqual(["still-waiting"]);
  });
});
