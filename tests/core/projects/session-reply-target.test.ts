import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/projects/group-bindings.js", () => ({
  bindingForSession: vi.fn(() => null),
}));

import { bindingForSession } from "../../../src/core/projects/group-bindings.js";
import {
  clearReplyTarget,
  recordReplyTarget,
  resolveReplyTarget,
} from "../../../src/core/projects/session-reply-target.js";

describe("session reply target", () => {
  beforeEach(() => {
    clearReplyTarget("s1");
    vi.mocked(bindingForSession).mockReturnValue(null);
  });

  it("records and resolves the most recent target from the store", () => {
    recordReplyTarget("s1", { channel: "telegram", chatId: "123" });
    expect(resolveReplyTarget("s1")).toEqual({ channel: "telegram", chatId: "123" });
    recordReplyTarget("s1", { channel: "lark", chatId: "oc_x" });
    expect(resolveReplyTarget("s1")).toEqual({ channel: "lark", chatId: "oc_x" });
  });

  it("falls back to a Lark group binding when the store has nothing", () => {
    vi.mocked(bindingForSession).mockReturnValue({
      chatId: "oc_group",
      binding: { workspacePath: "/w", sessionName: "s1", label: "x" },
    });
    expect(resolveReplyTarget("s1")).toEqual({ channel: "lark", chatId: "oc_group" });
  });

  it("returns null when neither store nor binding has a target", () => {
    expect(resolveReplyTarget("s1")).toBeNull();
  });

  it("clear removes the stored target", () => {
    recordReplyTarget("s1", { channel: "telegram", chatId: "123" });
    clearReplyTarget("s1");
    expect(resolveReplyTarget("s1")).toBeNull();
  });

  it("falls back to the bound Lark group after clearing a stored target", () => {
    vi.mocked(bindingForSession).mockReturnValue({
      chatId: "oc_group",
      binding: { workspacePath: "/w", sessionName: "s1", label: "x" },
    });
    recordReplyTarget("s1", { channel: "telegram", chatId: "123" });

    clearReplyTarget("s1");

    expect(resolveReplyTarget("s1")).toEqual({ channel: "lark", chatId: "oc_group" });
  });
});
