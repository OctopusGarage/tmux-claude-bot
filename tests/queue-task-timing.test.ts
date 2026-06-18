import { describe, expect, it } from "vitest";
import { MessageQueue } from "../src/core/command/queue.js";
import { cumulativeBusyMs, currentTask } from "../src/core/session/task-timing.js";

describe("queue brackets task-timing", () => {
  it("marks busy during the handler and clears it after", async () => {
    const q = new MessageQueue(10);
    let busyDuring = false;
    q.setHandler(async (m) => {
      busyDuring = currentTask(m.sessionName ?? "").busy;
      m.resolve("ok");
    });
    await new Promise<void>((done) => {
      q.enqueue({
        id: "1",
        text: "hi",
        chatId: "c",
        channel: "telegram",
        sessionName: "sess_t",
        action: "text",
        resolve: () => done(),
        reject: () => done(),
      });
    });
    expect(busyDuring).toBe(true);
    expect(currentTask("sess_t").busy).toBe(false);
    expect(cumulativeBusyMs("sess_t")).toBeGreaterThanOrEqual(0);
  });
});
