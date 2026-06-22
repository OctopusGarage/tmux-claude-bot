import { describe, expect, it } from "vitest";
import { observeSignal } from "../../src/core/autopilot/signal.js";
import { defaultState } from "../../src/core/autopilot/types.js";

function fakeDeps(over: { pane?: string; size?: number; processing?: boolean } = {}) {
  return {
    bridge: {
      capturePane: async () => over.pane ?? "",
    },
    queue: {
      size: () => over.size ?? 0,
      isSessionProcessing: () => over.processing ?? false,
    },
    configResolver: { detectAgentKind: async () => "claude" },
  } as never;
}

describe("observeSignal", () => {
  it("idle empty session → not busy, infinite idle, no pane flags, progressAt=0", async () => {
    const sig = await observeSignal(fakeDeps(), "s1", defaultState(), 1000, {
      paneIsAnimating: async () => false,
      lastActivityAt: async () => null,
    });
    expect(sig.busy).toBe(false);
    expect(sig.queueEmpty).toBe(true);
    expect(sig.idleForMs).toBe(Number.POSITIVE_INFINITY);
    expect(sig.pane.apiError).toBe(false);
    expect(sig.progressAt).toBe(0);
  });

  it("queued work or animation → busy", async () => {
    const sig = await observeSignal(fakeDeps({ size: 1 }), "s1", defaultState(), 1000, {
      paneIsAnimating: async () => false,
      lastActivityAt: async () => null,
    });
    expect(sig.busy).toBe(true);
    expect(sig.queueEmpty).toBe(false);
  });

  it("idle + no recent activity but pane animating → busy (animation tiebreaker)", async () => {
    const sig = await observeSignal(fakeDeps(), "s1", defaultState(), 1000, {
      paneIsAnimating: async () => true,
      lastActivityAt: async () => null,
    });
    expect(sig.queueEmpty).toBe(true);
    expect(sig.busy).toBe(true);
  });

  it("progressAt reflects lastActivityAt when non-null", async () => {
    const sig = await observeSignal(fakeDeps(), "s1", defaultState(), 1000, {
      paneIsAnimating: async () => false,
      lastActivityAt: async () => 500,
    });
    expect(sig.progressAt).toBe(500);
  });

  it("classifies pane text", async () => {
    const sig = await observeSignal(
      fakeDeps({ pane: "API Error: overloaded" }),
      "s1",
      defaultState(),
      1000,
      {
        paneIsAnimating: async () => false,
        lastActivityAt: async () => null,
      },
    );
    expect(sig.pane.apiError).toBe(true);
  });

  it("sentinels come from the agent's transcript turn, NOT the pane (which echoes injected prompts)", async () => {
    // a marker visible in the pane only (e.g. the bot's own injected prompt) must NOT count
    const paneOnly = await observeSignal(
      fakeDeps({ pane: "reply [GOAL_DONE] when done" }),
      "s1",
      defaultState(),
      1000,
      { paneIsAnimating: async () => false, lastActivityAt: async () => null },
    );
    expect(paneOnly.sentinels).toEqual([]);
    // a marker the AGENT actually emitted in its turn counts
    const fromAgent = await observeSignal(fakeDeps({ pane: "" }), "s1", defaultState(), 1000, {
      paneIsAnimating: async () => false,
      lastActivityAt: async () => null,
      recentAssistant: async () => "All set. [GOAL_DONE]",
    });
    expect(fromAgent.sentinels).toContain("GOAL_DONE");
  });

  it("empty pane → sentinels is []", async () => {
    const sig = await observeSignal(fakeDeps({ pane: "" }), "s1", defaultState(), 1000, {
      paneIsAnimating: async () => false,
      lastActivityAt: async () => null,
    });
    expect(sig.sentinels).toEqual([]);
  });
});
