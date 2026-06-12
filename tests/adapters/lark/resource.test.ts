import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn().mockResolvedValue({ code: 0 });
const chatCreateMock = vi.fn();

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    im = { v1: { message: { create: createMock }, chat: { create: chatCreateMock } } };
  },
  Domain: { Feishu: "feishu", Lark: "lark" },
}));

import { createBoundChat, notifyLarkOwner } from "../../../src/adapters/lark/resource.js";

function cfg(openIds: string[]) {
  return {
    appId: "cli_x",
    appSecret: "secret",
    allowedOpenIds: new Set(openIds),
    domain: "feishu" as const,
  };
}

describe("notifyLarkOwner", () => {
  beforeEach(() => createMock.mockClear());

  it("is a no-op when there is no allow-listed owner", async () => {
    await notifyLarkOwner(cfg([]), "hi");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("DMs the first allow-listed open_id with a text message", async () => {
    await notifyLarkOwner(cfg(["ou_owner", "ou_second"]), "♻️ restarted");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: "ou_owner",
        msg_type: "text",
        content: JSON.stringify({ text: "♻️ restarted" }),
      },
    });
  });
});

describe("createBoundChat", () => {
  beforeEach(() => chatCreateMock.mockReset());

  it("creates a private group with the owner invited and returns {chatId,name}", async () => {
    chatCreateMock.mockResolvedValue({ code: 0, data: { chat_id: "oc_new" } });

    const result = await createBoundChat(cfg(["ou_me"]), { name: "projX", inviteOpenId: "ou_me" });

    expect(result).toEqual({ chatId: "oc_new", name: "projX" });
    expect(chatCreateMock).toHaveBeenCalledWith({
      data: {
        name: "projX",
        chat_mode: "group",
        chat_type: "private",
        user_id_list: ["ou_me"],
      },
      params: { user_id_type: "open_id" },
    });
  });

  it("includes description only when provided", async () => {
    chatCreateMock.mockResolvedValue({ data: { chat_id: "oc_2" } });

    await createBoundChat(cfg(["ou_me"]), {
      name: "p",
      inviteOpenId: "ou_me",
      description: "hello",
    });

    const sent = chatCreateMock.mock.calls[0]?.[0] as { data: { description?: string } };
    expect(sent.data.description).toBe("hello");
  });

  it("throws a descriptive error when the response carries no chat_id", async () => {
    chatCreateMock.mockResolvedValue({ code: 0, data: {} });

    await expect(
      createBoundChat(cfg(["ou_me"]), { name: "p", inviteOpenId: "ou_me" }),
    ).rejects.toThrow(/no chat_id/);
  });
});
