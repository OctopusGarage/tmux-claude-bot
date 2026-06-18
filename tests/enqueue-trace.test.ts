import { describe, expect, it } from "vitest";
import { enqueueMessage } from "../src/core/command/enqueue.js";
import { MessageQueue } from "../src/core/command/queue.js";
import { runWithLogContext } from "../src/shared/utils/log-context.js";

describe("enqueueMessage captures the ambient traceId", () => {
  it("stamps the message with the context traceId", async () => {
    const q = new MessageQueue(10);
    let seenTrace: string | undefined;
    q.setHandler(async (m) => {
      seenTrace = m.traceId;
      m.resolve("ok");
    });
    await runWithLogContext({ traceId: "t_ingress" }, async () => {
      await new Promise<void>((done) => {
        void enqueueMessage(
          {
            queue: q,
            session: "tmux_proj_1",
            chatId: 123,
            channel: "telegram",
            action: "text",
            text: "hello",
            callbacks: {
              resolve: () => done(),
              reject: () => done(),
            },
          },
          {
            accepted: () => {},
            full: () => {},
          },
        );
      });
    });
    expect(seenTrace).toBe("t_ingress");
  });
});
