import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/projects/group-bindings.js", () => ({
  bindingForSession: vi.fn(() => null),
}));

import {
  boundLarkGroupForSession,
  resolveNotificationTargetPlan,
} from "../../../src/core/notifications/target-resolver.js";
import { bindingForSession } from "../../../src/core/projects/group-bindings.js";

describe("notification target resolver", () => {
  beforeEach(() => {
    vi.mocked(bindingForSession).mockReturnValue(null);
  });

  it("returns none when no notification channels are registered", () => {
    expect(resolveNotificationTargetPlan({ registeredChannels: [] })).toEqual({ kind: "none" });
  });

  it("prefers a bound Lark project group for session notifications", () => {
    vi.mocked(bindingForSession).mockReturnValue({
      chatId: "oc_group",
      binding: { workspacePath: "/workspace", sessionName: "tmux_proj_api", label: "api" },
    });

    expect(
      resolveNotificationTargetPlan({
        registeredChannels: ["telegram", "lark"],
        session: "tmux_proj_api",
        recentOwnerChannel: "telegram",
      }),
    ).toEqual({ kind: "primary", channel: "lark", fallback: "telegram" });
  });

  it("does not select a bound Lark group when the Lark channel is not registered", () => {
    vi.mocked(bindingForSession).mockReturnValue({
      chatId: "oc_group",
      binding: { workspacePath: "/workspace", sessionName: "tmux_proj_api", label: "api" },
    });

    expect(
      resolveNotificationTargetPlan({
        registeredChannels: ["telegram"],
        session: "tmux_proj_api",
        recentOwnerChannel: "telegram",
      }),
    ).toEqual({ kind: "single", channel: "telegram" });
  });

  it("uses the recent owner channel when no bound group owns the session", () => {
    expect(
      resolveNotificationTargetPlan({
        registeredChannels: ["telegram", "lark"],
        session: "tmux_proj_api",
        recentOwnerChannel: "telegram",
      }),
    ).toEqual({ kind: "primary", channel: "telegram", fallback: "lark" });
  });

  it("sends to both registered channels when there is no owner hint", () => {
    expect(resolveNotificationTargetPlan({ registeredChannels: ["telegram", "lark"] })).toEqual({
      kind: "both",
    });
  });

  it("resolves the concrete bound Lark group chat id", () => {
    vi.mocked(bindingForSession).mockReturnValue({
      chatId: "oc_group",
      binding: { workspacePath: "/workspace", sessionName: "tmux_proj_api", label: "api" },
    });

    expect(boundLarkGroupForSession("tmux_proj_api")).toEqual({ chatId: "oc_group" });
  });
});
