import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable collaborators — agentIsIdle is pure decision logic over them.
const h = vi.hoisted(() => ({
  lastActivityAt: vi.fn<() => Promise<number | null>>(),
  animating: vi.fn<() => Promise<boolean>>(),
  hasMethod: { value: true },
}));

vi.mock("../../src/core/agents/agentKindMap.js", () => ({
  resolveAgentKind: vi.fn(async () => "claude"),
}));
vi.mock("../../src/core/agents/registry.js", () => ({
  profileFor: vi.fn(() => (h.hasMethod.value ? { lastActivityAt: h.lastActivityAt } : {})),
}));
vi.mock("../../src/core/projects/sessionPathMap.js", () => ({
  getPathBySession: vi.fn(() => undefined),
}));
vi.mock("../../src/core/session/pane-activity.js", () => ({
  paneIsAnimating: h.animating,
}));

import { agentIsIdle } from "../../src/core/command/agent-ready.js";

const deps = { configResolver: {}, bridge: {} } as never;

describe("agentIsIdle (queue idle-gate)", () => {
  beforeEach(() => {
    h.hasMethod.value = true;
    h.animating.mockReset();
  });

  it("idle when the agent never wrote a transcript", async () => {
    h.lastActivityAt.mockResolvedValue(null);
    expect(await agentIsIdle(deps, "s")).toBe(true);
  });

  it("idle when the profile exposes no lastActivityAt at all", async () => {
    h.hasMethod.value = false;
    expect(await agentIsIdle(deps, "s")).toBe(true);
  });

  it("busy while a fresh write is still streaming", async () => {
    h.lastActivityAt.mockResolvedValue(Date.now() - 1_000);
    expect(await agentIsIdle(deps, "s")).toBe(false);
  });

  it("idle once quiet beyond the dormant window", async () => {
    h.lastActivityAt.mockResolvedValue(Date.now() - 120_000);
    expect(await agentIsIdle(deps, "s")).toBe(true);
  });

  it("busy when a long-quiet pane still shows a blocked Codex submit state", async () => {
    h.lastActivityAt.mockResolvedValue(Date.now() - 120_000);
    const blockedDeps = {
      configResolver: {},
      bridge: {
        capturePane: vi.fn(async () =>
          [
            "• UserPromptSubmit hook (blocked)",
            "• Messages to be submitted after next tool call",
            "› queued draft",
          ].join("\n"),
        ),
      },
    } as never;

    expect(await agentIsIdle(blockedDeps, "s")).toBe(false);
  });

  it("idle when Codex left a stale working marker above a completed turn", async () => {
    h.lastActivityAt.mockResolvedValue(Date.now() - 120_000);
    h.animating.mockResolvedValue(false);
    const completedDeps = {
      configResolver: {},
      bridge: {
        capturePane: vi.fn(async () =>
          [
            "◦ Working (46s • esc to interrupt)",
            "",
            "• [LOOP_SUPERVISOR_DONE:run-1]",
            "",
            "─ Worked for 9m 03s ─",
            "",
            "› Ask Codex to do anything",
          ].join("\n"),
        ),
      },
    } as never;

    expect(await agentIsIdle(completedDeps, "s")).toBe(true);
  });

  it("in the ambiguous window, an animating pane is busy", async () => {
    h.lastActivityAt.mockResolvedValue(Date.now() - 20_000);
    h.animating.mockResolvedValue(true);
    expect(await agentIsIdle(deps, "s")).toBe(false);
  });

  it("in the ambiguous window, a static pane is idle", async () => {
    h.lastActivityAt.mockResolvedValue(Date.now() - 20_000);
    h.animating.mockResolvedValue(false);
    expect(await agentIsIdle(deps, "s")).toBe(true);
  });

  it("never deadlocks the queue: a probe failure resolves to idle", async () => {
    h.lastActivityAt.mockRejectedValue(new Error("probe boom"));
    expect(await agentIsIdle(deps, "s")).toBe(true);
  });
});
