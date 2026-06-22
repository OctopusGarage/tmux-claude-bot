import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient } from "../../../src/adapters/control/client.js";
import { startControlServer } from "../../../src/adapters/control/server.js";
import { NotifierRegistry } from "../../../src/core/autopilot/notifier.js";
import type { QueuedMessage } from "../../../src/core/command/queue.js";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { OutputProcessor } from "../../../src/core/session/output.js";

function fakeDeps(): { deps: HandlerDeps; enqueued: QueuedMessage[] } {
  const enqueued: QueuedMessage[] = [];
  const deps = {
    bridge: { capturePaneColored: async (s: string) => `PANE for ${s}` },
    output: new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 }),
    queue: {
      enqueue: (msg: QueuedMessage) => {
        enqueued.push(msg);
        // mimic the bot's handler: run, then resolve with the reply
        setTimeout(() => msg.resolve(`REPLY:${msg.action}:${msg.text}`), 5);
        return "queued";
      },
    },
    activity: { onActivity: () => () => {} },
    notifier: new NotifierRegistry(),
  } as unknown as HandlerDeps;
  return { deps, enqueued };
}

const waitFor = <T>(client: ControlClient, ev: string): Promise<T> =>
  new Promise((res) => client.once(ev, res as (v: unknown) => void));

describe("control server ↔ client (real unix socket)", () => {
  let dir: string;
  let server: Server;
  let client: ControlClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-ctl-"));
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(async () => {
    client?.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    process.env.TCB_STATE_DIR = undefined;
  });

  it("handshakes, peeks the pane, and routes a prompt through the queue", async () => {
    const { deps, enqueued } = fakeDeps();
    server = startControlServer(deps);
    await new Promise((r) => setTimeout(r, 60)); // let it bind

    client = new ControlClient();
    const hello = waitFor<{ version: string }>(client, "hello");
    await client.connect();
    expect((await hello).version).toBeTruthy();

    // read path
    expect(await client.peek("sessA", 10)).toContain("PANE for sessA");

    // write path: ack now, reply event when the queued message resolves
    const reply = waitFor<{ session: string; output: string }>(client, "reply");
    const ack = await client.send("sessB", "hello world");
    expect(ack.status).toBe("queued");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      sessionName: "sessB",
      action: "text",
      text: "hello world",
      ephemeral: true,
    });
    expect(await reply).toEqual({
      event: "reply",
      session: "sessB",
      output: "REPLY:text:hello world",
    });
  });

  it("routes a control action with empty text", async () => {
    const { deps, enqueued } = fakeDeps();
    server = startControlServer(deps);
    await new Promise((r) => setTimeout(r, 60));
    client = new ControlClient();
    await client.connect();

    const ack = await client.control("sessC", "restart");
    expect(ack.status).toBe("queued");
    expect(enqueued[0]).toMatchObject({ sessionName: "sessC", action: "restart", text: "" });
  });

  it("auto-reconnects when the connection drops (server still up)", async () => {
    const { deps } = fakeDeps();
    server = startControlServer(deps);
    let serverConn: import("node:net").Socket | undefined;
    server.on("connection", (s) => {
      serverConn = s;
    });
    await new Promise((r) => setTimeout(r, 60));

    client = new ControlClient();
    await client.connect();
    expect(await client.peek("before", 5)).toContain("PANE for before");

    // Drop the connection (as if the bot had blipped); the server keeps listening.
    const reconnected = waitFor(client, "reconnected");
    serverConn?.destroy();
    await reconnected;

    // The client transparently works again on the new connection.
    expect(await client.peek("after", 5)).toContain("PANE for after");
  }, 8000);
});
