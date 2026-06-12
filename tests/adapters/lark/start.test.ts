import { Domain } from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import { larkChannelOptions } from "../../../src/adapters/lark/start.js";

describe("larkChannelOptions", () => {
  it("disables the SDK mention filter (policy.requireMention=false) so bound project groups work without @bot", () => {
    // Regression guard: the SDK's PolicyGate defaults requireMention=true, which
    // silently drops non-@ group messages before our handler runs. Must stay false.
    const opts = larkChannelOptions({ appId: "cli_x", appSecret: "s" }, Domain.Feishu);
    expect(opts.policy?.requireMention).toBe(false);
  });

  it("carries the credentials, domain and source tag", () => {
    const opts = larkChannelOptions({ appId: "cli_x", appSecret: "s" }, Domain.Lark);
    expect(opts).toMatchObject({
      appId: "cli_x",
      appSecret: "s",
      domain: Domain.Lark,
      source: "tmux-claude-bot",
    });
  });
});
