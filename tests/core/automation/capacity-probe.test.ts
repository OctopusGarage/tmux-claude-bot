import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("falls back to the latest account-wide Codex telemetry when the supervisor session is stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      const dir = join(root, "sessions", "2026", "08", "13");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "rollout-fresh.jsonl"),
        [
          `{"type":"session_meta","payload":{"id":"fresh","cwd":"/other-repo"}}`,
          `{"timestamp":"2026-08-13T08:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":10},"model_context_window":1000},"rate_limits":{"primary":{"used_percent":3,"window_minutes":10080,"resets_at":1787196811},"secondary":null}}}`,
        ].join("\n"),
      );
      const codexResolver = {
        resolveConfigRoot: async () => "/unused",
        isClaudeRunning: async () => false,
        resolveCodexHome: async () => root,
        isCodexRunning: async () => true,
        invalidate: () => undefined,
      } as ConfigResolver;

      const result = await observeAgentCapacity({
        agent: "codex",
        session: "loop-supervisor",
        projectPath: "/repo-without-rollout",
        resolver: codexResolver,
        now,
        resolveAuthentication: async () => "subscription",
      });

      expect(result).toMatchObject({
        state: "available",
        fiveHourPct: null,
        weeklyPct: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
