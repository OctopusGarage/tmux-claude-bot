import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageQueue } from "../../src/core/queue.js";

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
    q.enqueue({ id: "2", ...base }); // stays in the session queue (backlog)
    q.flushPending();

    const reloaded = q.loadPersisted();
    const backlogged = reloaded.find((m) => m.id === "2");
    expect(backlogged).toMatchObject({
      chatId: "oc_lark_chat",
      channel: "lark",
      sessionName: "sess_a",
    });
  });
});
