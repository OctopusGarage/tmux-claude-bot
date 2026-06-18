import { describe, expect, it } from "vitest";
import { MessageQueue } from "../src/core/command/queue.js";
import { currentLogContext } from "../src/shared/utils/log-context.js";

describe("queue re-establishes log context for the handler", () => {
  it("the handler runs inside the message's traceId/session/chat/channel", async () => {
    const q = new MessageQueue(10);
    const seen: Record<string, unknown> = {};
    q.setHandler(async (msg) => {
      Object.assign(seen, currentLogContext());
      msg.resolve("ok");
    });
    await new Promise<void>((done) => {
      q.enqueue({
        id: "1",
        text: "hi",
        chatId: "c9",
        channel: "lark",
        sessionName: "sess_z",
        traceId: "t_ctx",
        action: "text",
        resolve: () => done(),
        reject: () => done(),
      });
    });
    expect(seen).toMatchObject({
      traceId: "t_ctx",
      session: "sess_z",
      chatId: "c9",
      channel: "lark",
    });
  });
});
