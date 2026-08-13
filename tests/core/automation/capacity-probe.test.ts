import { describe, expect, it } from "vitest";
import type { ConfigResolver } from "../../../src/core/agents/agent-config-resolver.js";
import { observeAgentCapacity } from "../../../src/core/automation/capacity-probe.js";
import type { UsageSnapshot } from "../../../src/core/read/usage.js";

const resolver = {} as ConfigResolver;
const now = Date.UTC(2026, 7, 13, 8, 0, 0);

function usage(percent: number): UsageSnapshot {
  return {
    sessionId: "session-1",
    contextPct: 10,
    fiveHourPct: percent,
    fiveHourReset: Math.floor((now + 60_000) / 1_000),
    sevenDayPct: 20,
    sevenDayReset: Math.floor((now + 86_400_000) / 1_000),
    updatedAt: Math.floor(now / 1_000),
  };
}

describe("observeAgentCapacity", () => {
  it("maps subscription authentication and local usage into a capacity observation", async () => {
    const result = await observeAgentCapacity({
      agent: "claude",
      session: "loop-supervisor",
      projectPath: "/repo",
      resolver,
      now,
      resolveAuthentication: async () => "subscription",
      readUsage: async () => usage(92),
    });

    expect(result).toMatchObject({
      agent: "claude",
      authentication: "subscription",
      state: "constrained",
      fiveHourPct: 92,
    });
  });

  it("fails closed to unknown when local usage inspection throws", async () => {
    const result = await observeAgentCapacity({
      agent: "codex",
      session: "loop-supervisor",
      projectPath: "/repo",
      resolver,
      now,
      resolveAuthentication: async () => "usage-based",
      readUsage: async () => {
        throw new Error("transcript unavailable");
      },
    });

    expect(result).toMatchObject({
      agent: "codex",
      authentication: "usage-based",
      state: "unknown",
      latestReason: "usage-telemetry-unavailable",
    });
  });

  it("uses the profile default for a running Codex session without CODEX_HOME", async () => {
    const codexResolver = {
      resolveConfigRoot: async () => "/unused",
      isClaudeRunning: async () => false,
      resolveCodexHome: async () => null,
      isCodexRunning: async () => true,
      invalidate: () => undefined,
    } as ConfigResolver;

    const result = await observeAgentCapacity({
      agent: "codex",
      session: "loop-supervisor",
      projectPath: "/repo",
      resolver: codexResolver,
      now,
      resolveAuthentication: async () => "subscription",
      readUsage: async (effectiveResolver) => {
        expect(await effectiveResolver.resolveCodexHome?.("loop-supervisor")).toMatch(/\.codex$/);
        return usage(20);
      },
    });

    expect(result.state).toBe("available");
  });
});
