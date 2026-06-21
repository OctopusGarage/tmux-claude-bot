import { describe, expect, it } from "vitest";
import { resolveSessionForMessage } from "../src/adapters/telegram/reply-routing.js";
import type { ReplyTargetMap } from "../src/adapters/telegram/reply-target.js";

function fakeMap(entries: Record<number, string>): ReplyTargetMap {
  return {
    record() {},
    resolve: (id) => entries[id],
    removeSession() {},
    clear() {},
  };
}

describe("resolveSessionForMessage", () => {
  it("routes to the session of the replied-to message when present", () => {
    const map = fakeMap({ 42: "tmux_proj_replied" });
    expect(resolveSessionForMessage(42, map, "tmux_proj_current")).toBe("tmux_proj_replied");
  });

  it("falls back to the current session when not replying to a known message", () => {
    const map = fakeMap({});
    expect(resolveSessionForMessage(undefined, map, "tmux_proj_current")).toBe("tmux_proj_current");
  });

  it("falls back when the replied-to message is unknown", () => {
    const map = fakeMap({ 42: "tmux_proj_replied" });
    expect(resolveSessionForMessage(99, map, "tmux_proj_current")).toBe("tmux_proj_current");
  });

  it("returns null when neither a reply target nor a fallback exists", () => {
    const map = fakeMap({});
    expect(resolveSessionForMessage(undefined, map, null)).toBeNull();
  });
});
