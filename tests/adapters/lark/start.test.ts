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

  it("caps the dedup TTL to the 30-min stale window so card buttons aren't locked out for the SDK's 12h default", () => {
    // The SDK's default dedup TTL is 12h, and the SAME cache gates card-action
    // re-clicks — so a user can't re-press the same button on the same card for
    // 12h. Message-redelivery dedup only needs to outlast the 30-min stale window
    // (older events are dropped before dedup), so matching that window keeps message
    // dedup correct while freeing re-clicks after 30 min instead of 12h.
    const opts = larkChannelOptions({ appId: "cli_x", appSecret: "s" }, Domain.Feishu);
    expect(opts.safety?.dedup?.ttl).toBe(30 * 60_000);
  });

  it("lets LARK_DEDUP_TTL_MS override the dedup TTL", () => {
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
