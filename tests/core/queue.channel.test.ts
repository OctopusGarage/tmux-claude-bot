import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageQueue } from "../../src/core/command/queue.js";

let dir: string;
let persistPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-"));
  persistPath = path.join(dir, "pending.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("queue persistence with channel", () => {
  it("does not persist a backlogged chat message", () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {}));
    const base = {
      text: "hi",
      chatId: "oc_lark_chat",
      channel: "lark" as const,
      sessionName: "sess_a",
      action: "text",
      resolve: () => {},
      reject: () => {},
    };
    q.enqueue({ id: "1", ...base }); // dequeued immediately, blocks in handler
    q.enqueue({ id: "2", ...base, text: "bye" }); // stays in the session queue (backlog)
    q.flushPending();

    expect(q.loadPersisted()).toEqual([]);
  });

  it("persists a backlogged control message and reloads its routing fields", () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {}));
    const base = {
      text: "hi",
      chatId: "control",
      channel: "control" as const,
      sessionName: "sess_a",
      action: "text",
      resolve: () => {},
      reject: () => {},
    };
    q.enqueue({ id: "1", ...base });
    q.enqueue({ id: "2", ...base, text: "bye" });
    q.flushPending();

    expect(q.loadPersisted().find((m) => m.id === "2")).toMatchObject({
      chatId: "control",
      channel: "control",
      sessionName: "sess_a",
    });
  });

  it("persists explicit carryover alongside live backlog", () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {})); // blocks the in-flight message
    q.enqueue({
      id: "blocker",
      text: "block",
      chatId: "chat",
      channel: "control",
      sessionName: "sess",
      action: "text",
      resolve: () => {},
      reject: () => {},
    });
    q.enqueue({
      id: "live",
      text: "live-msg",
      chatId: "chat",
      channel: "control",
      sessionName: "sess",
      action: "text",
      resolve: () => {},
      reject: () => {},
    });

    q.keepPersistedCarryover([
      {
        id: "control-carryover",
        text: "control-msg",
        chatId: "control",
        channel: "control",
        sessionName: "sess_control",
        action: "text",
      },
    ]);
    q.flushPending();

    expect(
      q
        .loadPersisted()
        .map((message) => [message.id, message.dispatched === true])
        .sort(),
    ).toEqual([
      ["blocker", true],
      ["control-carryover", false],
      ["live", false],
    ]);
  });

  it("does NOT persist an ephemeral backlog message (the local-control transport)", () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {})); // block the in-flight message
    const base = {
      chatId: "c",
      sessionName: "sess_a",
      action: "text",
      resolve: () => {},
      reject: () => {},
    };
    q.enqueue({ id: "blocker", text: "block", channel: "control", ...base }); // in flight
    q.enqueue({ id: "keep", text: "normal", channel: "control", ...base }); // backlog → persisted
    q.enqueue({ id: "eph", text: "control", ephemeral: true, ...base }); // backlog → NOT persisted
    q.flushPending();
    // The ephemeral control message is queued in-memory (so per-session serialization
    // holds) but never written to disk — a restart must not "restore" it.
    expect(q.loadPersisted().map((m) => [m.id, m.dispatched === true])).toEqual([
      ["keep", false],
      ["blocker", true],
    ]);
  });

  it("persists and reloads a backlogged message's traceId", () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {})); // block the in-flight message
    const base = {
      chatId: "c",
      channel: "control" as const,
      sessionName: "s",
      action: "text",
      resolve: () => {},
      reject: () => {},
    };
    q.enqueue({ id: "1", text: "hi", traceId: "t_aaa", ...base }); // dequeued, in flight
    q.enqueue({ id: "2", text: "bye", traceId: "t_bbb", ...base }); // backlog
    q.flushPending();
    expect(q.loadPersisted().find((m) => m.id === "2")?.traceId).toBe("t_bbb");
  });

  it("marks an in-flight persisted message as dispatched before the handler settles", async () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {}));

    q.enqueue({
      id: "in-flight",
      text: "already typed",
      chatId: "control",
      channel: "control",
      sessionName: "sess_a",
      action: "text",
      resolve: () => {},
      reject: () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    q.flushPending();

    expect(q.loadPersisted()).toContainEqual(
      expect.objectContaining({
        id: "in-flight",
        dispatched: true,
      }),
    );
  });
});
