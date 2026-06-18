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
  it("persists a backlogged message's string chatId and channel, reloads them", () => {
    const q = new MessageQueue(10, persistPath);
    // A handler that never resolves keeps the first message in-flight, so the
    // second one stays queued as backlog — which is what gets persisted.
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
    // Distinct text so it's a genuine backlog, not a dedup of the in-flight "hi".
    q.enqueue({ id: "2", ...base, text: "bye" }); // stays in the session queue (backlog)
    q.flushPending();

    const reloaded = q.loadPersisted();
    const backlogged = reloaded.find((m) => m.id === "2");
    expect(backlogged).toMatchObject({
      chatId: "oc_lark_chat",
      channel: "lark",
      sessionName: "sess_a",
    });
  });

  it("clearPersistedChannel drops only one channel's backlog (each adapter restores its own)", () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {})); // blocks the in-flight message
    const base = {
      chatId: "c",
      sessionName: "sess_a",
      action: "text",
      resolve: () => {},
      reject: () => {},
    };
    q.enqueue({ id: "blocker", text: "block", channel: "telegram", ...base }); // dequeued → in flight
    q.enqueue({ id: "L", text: "lark-msg", channel: "lark", ...base }); // backlog
    q.enqueue({ id: "T", text: "tg-msg", channel: "telegram", ...base }); // backlog
    q.enqueue({ id: "G", text: "legacy-msg", ...base }); // backlog, no channel → counts as telegram
    q.flushPending();
    expect(
      q
        .loadPersisted()
        .map((m) => m.id)
        .sort(),
    ).toEqual(["G", "L", "T"]);

    // Lark restores + drops its own: only Telegram + legacy entries remain.
    q.clearPersistedChannel("lark");
    expect(
      q
        .loadPersisted()
        .map((m) => m.id)
        .sort(),
    ).toEqual(["G", "T"]);

    // Telegram drops its own (legacy no-channel counts as telegram) → file empty.
    q.clearPersistedChannel("telegram");
    expect(q.loadPersisted()).toEqual([]);
  });

  it("persists and reloads a backlogged message's traceId", () => {
    const q = new MessageQueue(10, persistPath);
    q.setHandler(() => new Promise<void>(() => {})); // block the in-flight message
    const base = {
      chatId: "c",
      channel: "telegram" as const,
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
});
