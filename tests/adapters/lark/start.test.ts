import { Domain } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeepaliveDeps } from "../../../src/adapters/lark/keepalive.js";
import {
  larkChannelOptions,
  logIncomingMessageBoundary,
  reconnectLarkChannel,
  startLark,
} from "../../../src/adapters/lark/start.js";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { NotificationGateway } from "../../../src/core/notifications/gateway.js";
import { ChannelSenderRegistry } from "../../../src/core/projects/channel-sender.js";

const mocks = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionStatus: vi.fn(() => ({ state: "closed" })),
  };
  return {
    channel,
    createLarkChannel: vi.fn(() => channel),
    makeMessageHandler: vi.fn(() => vi.fn()),
    makeCardActionHandler: vi.fn(() => vi.fn()),
    startKeepalive: vi.fn<(deps: KeepaliveDeps) => void>(),
    registerLarkNotifications: vi.fn(),
  };
});

vi.mock("@larksuiteoapi/node-sdk", () => ({
  createLarkChannel: mocks.createLarkChannel,
  Domain: { Feishu: "feishu", Lark: "lark" },
  LoggerLevel: { info: "info" },
}));

vi.mock("../../../src/adapters/lark/handlers.js", () => ({
  makeMessageHandler: mocks.makeMessageHandler,
}));

vi.mock("../../../src/adapters/lark/card-actions.js", () => ({
  makeCardActionHandler: mocks.makeCardActionHandler,
}));

vi.mock("../../../src/adapters/lark/keepalive.js", () => ({
  startKeepalive: mocks.startKeepalive,
}));

vi.mock("../../../src/adapters/lark/notifications.js", () => ({
  registerLarkNotifications: mocks.registerLarkNotifications,
}));

function deps(): HandlerDeps {
  return {
    config: {
      lark: {
        appId: "cli_x",
        appSecret: "secret",
        domain: "feishu",
        allowedOpenIds: new Set(["ou_owner"]),
      },
    },
    notifications: new NotificationGateway(),
    channelSenders: new ChannelSenderRegistry(),
  } as unknown as HandlerDeps;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("larkChannelOptions", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("disables the SDK mention filter so bound project groups work without @bot", async () => {
    const opts = larkChannelOptions({ appId: "cli_x", appSecret: "s" }, Domain.Feishu);

    expect(opts.policy?.requireMention).toBe(false);
  });

  it("carries the credentials, domain and source tag", async () => {
    const opts = larkChannelOptions({ appId: "cli_x", appSecret: "s" }, Domain.Lark);

    expect(opts).toMatchObject({
      appId: "cli_x",
      appSecret: "s",
      domain: Domain.Lark,
      source: "tmux-claude-bot",
    });
  });

  it("caps the dedup TTL to the 30-min stale window", async () => {
    const opts = larkChannelOptions({ appId: "cli_x", appSecret: "s" }, Domain.Feishu);

    expect(opts.safety?.dedup?.ttl).toBe(30 * 60_000);
  });

  it("lets LARK_DEDUP_TTL_MS override the dedup TTL", async () => {
    const prev = process.env.LARK_DEDUP_TTL_MS;
    process.env.LARK_DEDUP_TTL_MS = "120000";
    try {
      const opts = larkChannelOptions({ appId: "cli_x", appSecret: "s" }, Domain.Feishu);
      expect(opts.safety?.dedup?.ttl).toBe(120000);
    } finally {
      if (prev === undefined) delete process.env.LARK_DEDUP_TTL_MS;
      else process.env.LARK_DEDUP_TTL_MS = prev;
    }
  });
});

describe("startLark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.channel.connect.mockReset();
    mocks.channel.disconnect.mockReset();
  });

  it("recovers the initial websocket failure through the keepalive path", async () => {
    mocks.channel.connect
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(undefined);
    startLark(deps());
    const keepalive = mocks.startKeepalive.mock.calls[0]?.[0];
    expect(keepalive?.shouldRecoverUninitialized?.()).toBe(false);
    await flushMicrotasks();

    expect(mocks.channel.connect).toHaveBeenCalledTimes(1);
    expect(keepalive?.shouldRecoverUninitialized?.()).toBe(true);
    await keepalive?.forceReconnect();

    expect(mocks.channel.connect).toHaveBeenCalledTimes(2);
    expect(keepalive?.shouldRecoverUninitialized?.()).toBe(false);
    expect(mocks.registerLarkNotifications).toHaveBeenCalledTimes(1);
  });
});

describe("logIncomingMessageBoundary", () => {
  it("accepts normalized message metadata before business routing", async () => {
    expect(() =>
      logIncomingMessageBoundary({
        chatId: "oc_group",
        chatType: "group",
        rawContentType: "text",
        senderId: "ou_owner",
      } as never),
    ).not.toThrow();
  });
});

describe("reconnectLarkChannel", () => {
  it("connects directly when the initial failure left the channel uninitialized", async () => {
    const channel = {
      getConnectionStatus: vi.fn(() => undefined),
      disconnect: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
    };

    await reconnectLarkChannel(channel as never);

    expect(channel.disconnect).not.toHaveBeenCalled();
    expect(channel.connect).toHaveBeenCalledOnce();
  });

  it("disconnects before reconnecting an initialized stuck channel", async () => {
    const channel = {
      getConnectionStatus: vi.fn(() => ({ state: "reconnecting", reconnectAttempts: 1 })),
      disconnect: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
    };

    await reconnectLarkChannel(channel as never);

    expect(channel.disconnect).toHaveBeenCalledOnce();
    expect(channel.connect).toHaveBeenCalledOnce();
  });
});
