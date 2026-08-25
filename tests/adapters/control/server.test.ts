import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "../../../src/adapters/control/client.js";
import {
  type ControlRequest,
  controlSocketPath,
  createLineDecoder,
} from "../../../src/adapters/control/protocol.js";
import { hardenControlSocket, startControlServer } from "../../../src/adapters/control/server.js";
import type { QueuedMessage } from "../../../src/core/command/queue.js";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { OutputProcessor } from "../../../src/core/session/output.js";

function fakeDeps(): { deps: HandlerDeps; enqueued: QueuedMessage[] } {
  const enqueued: QueuedMessage[] = [];
  const deps = {
    bridge: { capturePaneColored: async (s: string) => `PANE for ${s}` },
    config: { projectSessionPrefix: "tmux_proj_" },
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

  it("binds the control socket owner-only even with a permissive umask", async () => {
    const previousUmask = process.umask(0);
    try {
      const { deps } = fakeDeps();
      server = startControlServer(deps);
      await new Promise((r) => setTimeout(r, 60));

      expect(statSync(controlSocketPath()).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("sends caller provenance on control client requests", async () => {
    const received = new Promise<ControlRequest>((resolve) => {
      server = net.createServer((socket) => {
        socket.setEncoding("utf8");
        const decode = createLineDecoder<ControlRequest>();
        socket.on("data", (chunk: string) => {
          const [msg] = decode(chunk);
          if (msg === undefined) return;
          resolve(msg);
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, data: {} })}\n`);
        });
      });
    });
    server.listen(controlSocketPath());
    await new Promise((r) => setTimeout(r, 20));

    client = new ControlClient();
    await client.connect();
    await client.snapshot();

    expect(await received).toMatchObject({
      op: "snapshot",
      caller: {
        source: "control-client",
        cwd: process.cwd(),
        pid: process.pid,
      },
    });
  });

  it("closes the control server when socket permission hardening fails", () => {
    const close = vi.fn();

    expect(
      hardenControlSocket(join(dir, "missing.sock"), {
        close,
      } as unknown as Pick<Server, "close">),
    ).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("falls back to a nested state/control.sock when the client env points at the app home", async () => {
    const appHome = mkdtempSync(join(tmpdir(), "tcb-ctl-home-"));
    const nestedState = join(appHome, "state");
    mkdirSync(nestedState);
    rmSync(dir, { recursive: true, force: true });
    dir = appHome;

    process.env.TCB_STATE_DIR = nestedState;
    const { deps } = fakeDeps();
    server = startControlServer(deps);
    await new Promise((r) => setTimeout(r, 60));

    process.env.TCB_STATE_DIR = appHome;
    client = new ControlClient();
    await client.connect();

    expect(await client.peek("legacy-env", 10)).toContain("PANE for legacy-env");
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

  it("marks sends from a loop supervisor session as system-origin control work", async () => {
    const { deps, enqueued } = fakeDeps();
    server = startControlServer(deps);
    await new Promise((r) => setTimeout(r, 60));
    client = new ControlClient();
    await client.connect();

    const ack = await client.send("sessB", "supervisor prompt", {
      callerSession: "tmux_proj_loop-supervisor-1",
    });

    expect(ack.status).toBe("queued");
    expect(enqueued[0]).toMatchObject({
      sessionName: "sessB",
      action: "text",
      text: "supervisor prompt",
      origin: "system",
    });
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

  it("times out a request when the socket stays open but never replies", async () => {
    const sockets: net.Socket[] = [];
    server = net.createServer();
    server.on("connection", (socket) => {
      sockets.push(socket);
    });
    server.listen(join(dir, "control.sock"));
    await new Promise((r) => server.once("listening", r));

    client = new ControlClient({ requestTimeoutMs: 20 });
    await client.connect();

    await expect(client.peek("silent", 5)).rejects.toThrow("control request timed out after 20ms");
    for (const socket of sockets) socket.destroy();
  });

  it("fails a request immediately when the socket write fails", async () => {
    client = new ControlClient({ requestTimeoutMs: 10_000 });
    const socket = new EventEmitter() as EventEmitter & {
      end: () => void;
      write: (chunk: string, cb?: (err?: Error) => void) => boolean;
    };
    socket.end = () => {};
    socket.write = (_chunk, cb) => {
      setTimeout(() => cb?.(new Error("write failed")), 0);
      return false;
    };

    (client as unknown as { wire: (conn: typeof socket) => void }).wire(socket);

    await expect(client.peek("broken", 5)).rejects.toThrow(
      "control request write failed: write failed",
    );
  });
});
