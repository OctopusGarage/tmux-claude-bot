import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { NotificationGateway } from "../../../src/core/notifications/gateway.js";
import { ChannelSenderRegistry } from "../../../src/core/projects/channel-sender.js";

const mocks = vi.hoisted(() => ({
  notifyLarkOwner: vi.fn(async () => {}),
  notifyLarkOwnerCard: vi.fn(async () => {}),
  clientFor: vi.fn(() => ({})),
  sendLarkAttachment: vi.fn(async () => {}),
  boundLarkGroupForSession: vi.fn(),
}));

vi.mock("../../../src/adapters/lark/resource.js", () => ({
  notifyLarkOwner: mocks.notifyLarkOwner,
  notifyLarkOwnerCard: mocks.notifyLarkOwnerCard,
  clientFor: mocks.clientFor,
}));
vi.mock("../../../src/adapters/lark/media.js", () => ({
  sendLarkAttachment: mocks.sendLarkAttachment,
}));
vi.mock("../../../src/core/notifications/target-resolver.js", () => ({
  boundLarkGroupForSession: mocks.boundLarkGroupForSession,
}));

const channel = {
  send: vi.fn(async (_chatId: string, _input: unknown) => ({ messageId: "om_sent" })),
};

function deps(): HandlerDeps {
  return {
    config: {
      lark: larkConfig(),
    },
    notifications: new NotificationGateway(),
    channelSenders: new ChannelSenderRegistry(),
  } as unknown as HandlerDeps;
}

function larkConfig(): NonNullable<HandlerDeps["config"]["lark"]> {
  return {
    appId: "cli_x",
    appSecret: "secret",
    domain: "feishu",
    allowedOpenIds: new Set(["ou_owner"]),
  };
}

describe("registerLarkNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boundLarkGroupForSession.mockReturnValue(null);
  });

  it("registers a lark owner notification sender", async () => {
    const { registerLarkNotifications } = await import(
      "../../../src/adapters/lark/notifications.js"
    );
    const d = deps();
    const register = vi.spyOn(d.notifications, "register");
    const registerAttachment = vi.spyOn(d.notifications, "registerAttachment");

    registerLarkNotifications(d, larkConfig(), channel as never);
    expect(register).toHaveBeenCalledWith("lark", expect.any(Function));
    expect(registerAttachment).toHaveBeenCalledWith("lark", expect.any(Function));

    const sender = register.mock.calls.find((c) => c[0] === "lark")?.[1];
    await sender?.("hello from local project");

    expect(mocks.notifyLarkOwner).toHaveBeenCalledWith(d.config.lark, "hello from local project");

    const attachmentSender = registerAttachment.mock.calls.find((c) => c[0] === "lark")?.[1];
    await attachmentSender?.("/tmp/report.html", "file", "Radar report");

    expect(mocks.sendLarkAttachment).toHaveBeenCalledWith(
      expect.anything(),
      "ou_owner",
      "/tmp/report.html",
      "file",
      "Radar report",
      undefined,
      "open_id",
    );
  });

  it("routes lark session notification attachments to the bound project group", async () => {
    mocks.boundLarkGroupForSession.mockReturnValue({ chatId: "oc_group" });
    const { registerLarkNotifications } = await import(
      "../../../src/adapters/lark/notifications.js"
    );
    const d = deps();
    const registerAttachment = vi.spyOn(d.notifications, "registerAttachment");

    registerLarkNotifications(d, larkConfig(), channel as never);
    const attachmentSender = registerAttachment.mock.calls.find((c) => c[0] === "lark")?.[1];
    await attachmentSender?.("/tmp/report.html", "file", "Radar report", {
      title: "Long task finished: api",
      session: "tmux_proj_api",
    });

    expect(mocks.boundLarkGroupForSession).toHaveBeenCalledWith("tmux_proj_api");
    expect(mocks.sendLarkAttachment).toHaveBeenCalledWith(
      expect.anything(),
      "oc_group",
      "/tmp/report.html",
      "file",
      "Radar report",
      undefined,
      undefined,
    );
  });

  it("routes lark session notifications to the bound project group", async () => {
    mocks.boundLarkGroupForSession.mockReturnValue({ chatId: "oc_group" });
    const { registerLarkNotifications } = await import(
      "../../../src/adapters/lark/notifications.js"
    );
    const d = deps();
    const register = vi.spyOn(d.notifications, "register");

    registerLarkNotifications(d, larkConfig(), channel as never);
    const sender = register.mock.calls.find((c) => c[0] === "lark")?.[1];
    await sender?.("long task done", {
      title: "Long task finished: api",
      session: "tmux_proj_api",
    });

    expect(mocks.boundLarkGroupForSession).toHaveBeenCalledWith("tmux_proj_api");
    expect(channel.send).toHaveBeenCalledWith("oc_group", { markdown: "long task done" });
    expect(mocks.notifyLarkOwner).not.toHaveBeenCalled();
  });

  it("renders opportunity discovery notifications as project-group cards", async () => {
    mocks.boundLarkGroupForSession.mockReturnValue({ chatId: "oc_group" });
    const { registerLarkNotifications } = await import(
      "../../../src/adapters/lark/notifications.js"
    );
    const d = deps();
    const register = vi.spyOn(d.notifications, "register");

    registerLarkNotifications(d, larkConfig(), channel as never);
    const sender = register.mock.calls.find((c) => c[0] === "lark")?.[1];
    await sender?.("fallback text", {
      title: "Opportunity suggestions: api",
      source: "opportunity-discovery",
      session: "tmux_proj_api",
      body: "Project: api\nSuggestions: 1",
      opportunities: [
        {
          id: "api-20260729-abc123",
          title: "Add explain command",
          projectName: "api",
          category: "developer-experience",
          confidence: "high",
          estimatedComplexity: "small",
          status: "proposed",
          value: "Faster support.",
        },
      ],
    });

    expect(channel.send).toHaveBeenCalledWith(
      "oc_group",
      expect.objectContaining({ card: expect.any(Object) }),
    );
    const sent = JSON.stringify(channel.send.mock.calls.at(-1)?.[1]);
    expect(sent).toContain("oppdiscuss");
    expect(sent).not.toContain("oppdelegate");
    expect(mocks.notifyLarkOwner).not.toHaveBeenCalled();
  });
});
