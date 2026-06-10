import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn().mockResolvedValue({ code: 0 });

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    im = { v1: { message: { create: createMock } } };
  },
  Domain: { Feishu: "feishu", Lark: "lark" },
}));

import { notifyLarkOwner } from "../../../src/adapters/lark/resource.js";

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
