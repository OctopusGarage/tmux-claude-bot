import { beforeEach, describe, expect, it, vi } from "vitest";
import { pollUntilIdle, pollUntilReady } from "../../src/core/agents/pane-poll.js";
import type { OutputProcessor } from "../../src/core/session/output.js";
import type { TmuxBridge } from "../../src/core/session/tmux.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("../../src/shared/utils/logger.js", () => ({
  createLogger: () => log,
  logger: log,
}));

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
  beforeEach(() => vi.clearAllMocks());

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

  it("coalesces repeated pane-capture failures and records recovery", async () => {
    const capturePane = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("pane unavailable"))
      .mockRejectedValueOnce(new Error("pane unavailable"))
      .mockResolvedValue(stablePane);
    const bridge = { capturePane, sendRawKey: vi.fn() } as unknown as TmuxBridge;

    await pollUntilReady({
      bridge,
      pollIntervalMs: 1,
      maxWaitReadyMs: 5,
      sessionName: "sess",
      logTag: "[test]",
      notReadyError: "not ready",
      classify: () => "ready",
    });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "agent pane capture recovered",
      expect.objectContaining({ session: "sess", data: expect.objectContaining({ failures: 2 }) }),
    );
  });
});

describe("pollUntilIdle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports one warning rather than one error per repeated capture failure", async () => {
    const bridge = {
      capturePane: vi.fn(async () => {
        throw new Error("session disappeared");
      }),
    } as unknown as TmuxBridge;
    const output = { process: vi.fn(() => "") } as unknown as OutputProcessor;

    const result = await pollUntilIdle({
      bridge,
      output,
      idlePollTicks: 2,
      pollIntervalMs: 1,
      maxWaitDoneMs: 3,
      sessionName: "sess",
      logTag: "[test]",
    });

    expect(result.done).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(2); // first failure + terminal timeout summary
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });
});
