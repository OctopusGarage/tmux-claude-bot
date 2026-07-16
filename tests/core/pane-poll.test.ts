import { describe, expect, it, vi } from "vitest";
import { pollUntilReady } from "../../src/core/agents/pane-poll.js";
import type { TmuxBridge } from "../../src/core/session/tmux.js";

vi.mock("../../src/shared/utils/sleep.js", () => ({
  sleep: vi.fn(async () => {}),
}));

function bridgeWithPanes(panes: readonly string[]) {
  let index = 0;
  const sent: string[] = [];
  const bridge = {
    capturePane: vi.fn(async () => {
      const pane = panes[Math.min(index, panes.length - 1)] ?? "";
      index += 1;
      return pane;
    }),
    sendRawKey: vi.fn(async (key: string) => {
      sent.push(key);
    }),
  } as unknown as TmuxBridge;
  return { bridge, sent };
}

const stablePane = ["RESKINNED UI", "line two", "line three", "line four"].join("\n");

describe("pollUntilReady", () => {
  it("falls back to ready when an unmarked pane is stable, substantive, and alive", async () => {
    const { bridge } = bridgeWithPanes([stablePane, stablePane, stablePane]);
    const isAlive = vi.fn(async () => true);

    await expect(
      pollUntilReady({
        bridge,
        pollIntervalMs: 1,
        maxWaitReadyMs: 10,
        sessionName: "sess",
        logTag: "[test]",
        notReadyError: "not ready",
        classify: () => "wait",
        stableReady: { ticks: 2, minLines: 3, isAlive },
      }),
    ).resolves.not.toThrow();

    expect(bridge.capturePane).toHaveBeenCalledTimes(3);
    expect(isAlive).toHaveBeenCalledTimes(1);
  });

  it("does not use the stable-pane fallback while an active turn marker is visible", async () => {
    const activePane = ["working", "esc to interrupt", "line three", "line four"].join("\n");
    const { bridge } = bridgeWithPanes([activePane]);
    const isAlive = vi.fn(async () => true);

    await expect(
      pollUntilReady({
        bridge,
        pollIntervalMs: 1,
        maxWaitReadyMs: 3,
        sessionName: "sess",
        logTag: "[test]",
        notReadyError: "not ready",
        classify: () => "wait",
        isActiveTurn: (pane) => pane.includes("esc to interrupt"),
        stableReady: { ticks: 1, minLines: 3, isAlive },
      }),
    ).rejects.toThrow("not ready");

    expect(isAlive).not.toHaveBeenCalled();
  });

  it("resets stability after sending confirm-gate keys before falling back to ready", async () => {
    const gatePane = ["Do you trust this directory?", "› 1. Yes", "Press enter"].join("\n");
    const { bridge, sent } = bridgeWithPanes([gatePane, stablePane, stablePane, stablePane]);

    await expect(
      pollUntilReady({
        bridge,
        pollIntervalMs: 1,
        maxWaitReadyMs: 10,
        sessionName: "sess",
        logTag: "[test]",
        notReadyError: "not ready",
        classify: (pane) => (pane === gatePane ? { sendRawKeys: ["Down", "Enter"] } : "wait"),
        stableReady: { ticks: 2, minLines: 3, isAlive: vi.fn(async () => true) },
      }),
    ).resolves.not.toThrow();

    expect(sent).toEqual(["Down", "Enter"]);
    expect(bridge.capturePane).toHaveBeenCalledTimes(4);
  });
});
