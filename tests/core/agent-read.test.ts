import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../src/core/deps.js";

const h = vi.hoisted(() => ({
  resolveAgentKind: vi.fn(async () => "codex" as const),
  getRecentConversations: vi.fn(async () => [
    { user: "u", assistant: "a", time: "01/01 00:00", timeMs: 1000 },
  ]),
  listSessions: vi.fn(async () => [{ sessionId: "sid-1", cwd: "/project", mtimeMs: 1000 }]),
  getLatestReply: vi.fn(async () => "latest reply"),
  buildStatusReport: vi.fn(async () => "status body"),
  profileFor: vi.fn(),
}));

vi.mock("../../src/core/agents/agentKindMap.js", () => ({
  resolveAgentKind: h.resolveAgentKind,
}));

vi.mock("../../src/core/agents/registry.js", () => ({
  profileFor: h.profileFor,
}));

h.profileFor.mockReturnValue({
  getRecentConversations: h.getRecentConversations,
  listSessions: h.listSessions,
  getLatestReply: h.getLatestReply,
  buildStatusReport: h.buildStatusReport,
});

describe("agent read-side service", () => {
  it("resolves the agent kind once and reads recent conversations through that profile", async () => {
    const { readAgentRecentConversations } = await import("../../src/core/agents/read.js");
    const resolver = { resolveConfigRoot: vi.fn(async () => "/cfg") };

    const rounds = await readAgentRecentConversations(resolver, "sess", "/project");

    expect(rounds).toEqual([{ user: "u", assistant: "a", time: "01/01 00:00", timeMs: 1000 }]);
    expect(h.resolveAgentKind).toHaveBeenCalledWith(resolver, "sess");
    expect(h.profileFor).toHaveBeenCalledWith("codex");
    expect(h.getRecentConversations).toHaveBeenCalledWith(resolver, "sess", "/project");
  });

  it("reads the latest reply through the resolved profile", async () => {
    const { readAgentLatestReply } = await import("../../src/core/agents/read.js");
    const resolver = { resolveConfigRoot: vi.fn(async () => "/cfg") };

    await expect(readAgentLatestReply(resolver, "sess", "/project", "sent")).resolves.toBe(
      "latest reply",
    );
    expect(h.getLatestReply).toHaveBeenCalledWith(resolver, "sess", "/project", "sent");
  });

  it("lists saved sessions through the resolved profile", async () => {
    const { readAgentSessions } = await import("../../src/core/agents/read.js");
    const resolver = { resolveConfigRoot: vi.fn(async () => "/cfg") };

    await expect(readAgentSessions(resolver, "sess", "/project")).resolves.toEqual([
      { sessionId: "sid-1", cwd: "/project", mtimeMs: 1000 },
    ]);
    expect(h.listSessions).toHaveBeenCalledWith(resolver, "sess", "/project");
  });

  it("builds status through the resolved profile", async () => {
    const { buildAgentStatusReport } = await import("../../src/core/agents/read.js");
    const deps = { configResolver: { resolveConfigRoot: vi.fn(async () => "/cfg") } };

    await expect(
      buildAgentStatusReport(deps as unknown as HandlerDeps, "sess", "telegram", true),
    ).resolves.toBe("status body");
    expect(h.buildStatusReport).toHaveBeenCalledWith(deps, "sess", "telegram", true);
  });
});
