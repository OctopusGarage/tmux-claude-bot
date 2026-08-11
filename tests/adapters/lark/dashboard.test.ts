import { beforeEach, describe, expect, it, vi } from "vitest";

const { makeMessageHandler } = await import("../../../src/adapters/lark/handlers.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");

function depsForDashboard(over = {}) {
  return fakeDeps({
    session: "proj-1",
    bridge: {
      listProjectSessions: vi.fn(async () => [] as string[]),
      sessionsCreatedAt: vi.fn(async () => new Map<string, number>()),
    },
    ...over,
  });
}

describe("/dashboard (Lark) — owner-only, p2p", () => {
  beforeEach(() => vi.clearAllMocks());

  it("p2p owner gets a card with the global header", async () => {
    const channel = fakeChannel();
    const deps = depsForDashboard();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/dashboard", chatType: "p2p" }));

    const cards = JSON.stringify(channel.cards());
    expect(cards).toContain("tmux-claude-bot");
    expect(cards).toContain("sessions");
    expect(cards).toContain("总体健康");
    expect(cards).toContain("待处理");
  });

  it("does NOT expose the dashboard in a group context (no send)", async () => {
    // A bound group whose member runs /dashboard must get nothing back.
    const { bindGroup, unbindGroup } = await import("../../../src/core/projects/group-bindings.js");
    bindGroup("grp-dash", {
      workspacePath: "/proj/one",
      sessionName: "proj-1",
      label: "one",
    });
    try {
      const channel = fakeChannel();
      const deps = depsForDashboard();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/dashboard", chatId: "grp-dash", chatType: "group" }));

      expect(JSON.stringify(channel.cards())).not.toContain("tmux-claude-bot");
      expect(channel.texts().join("\n")).not.toContain("tmux-claude-bot");
    } finally {
      unbindGroup("grp-dash");
    }
  });

  it("non-allowlisted sender gets nothing", async () => {
    const channel = fakeChannel();
    const deps = depsForDashboard();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/dashboard", senderId: "ou_stranger" }));

    expect(channel.sent).toHaveLength(0);
  });
});
