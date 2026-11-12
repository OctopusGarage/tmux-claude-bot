import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sendContextReset } from "../../src/core/command/context-reset.js";

function fakeDeps() {
  return {
    bridge: {
      sendKeys: vi.fn(async () => undefined),
      sendRawKey: vi.fn(async () => undefined),
      capturePane: vi.fn(async () => "› \nContext 100% left"),
    },
    configResolver: { invalidate: vi.fn() },
    agent: { waitUntilInputReady: vi.fn(async () => undefined) },
  } as any;
}

describe("sendContextReset", () => {
  it("sends /compact and invalidates the resolver", async () => {
    const d = fakeDeps();
    await sendContextReset(d, "tmux_proj_x", "compact", { settleMs: 0 });
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/compact", "tmux_proj_x");
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("tmux_proj_x");
    expect(d.agent.waitUntilInputReady).toHaveBeenCalledWith("tmux_proj_x");
  });
  it("sends /clear and invalidates the resolver", async () => {
    const d = fakeDeps();
    await sendContextReset(d, "s1", "clear", { settleMs: 0 });
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/clear", "s1");
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("s1");
    expect(d.agent.waitUntilInputReady).toHaveBeenCalledWith("s1");
    expect(d.bridge.sendRawKey).not.toHaveBeenCalled();
  });
  it("does not press Enter again when the reset command was already submitted", async () => {
    const d = fakeDeps();
    await sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true });
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/clear", "s1");
    expect(d.bridge.sendRawKey).not.toHaveBeenCalled();
    expect(d.agent.waitUntilInputReady).toHaveBeenCalledTimes(1);
  });
  it("keeps confirming while the reset command remains in the active composer", async () => {
    const d = fakeDeps();
    d.bridge.capturePane = vi
      .fn()
      .mockResolvedValueOnce("› \nContext 100% left")
      .mockResolvedValueOnce("› /clear\nmain · Context 100% left")
      .mockResolvedValueOnce("› \nmain · Context 100% left");

    await sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true });

    expect(d.bridge.sendRawKey).toHaveBeenCalledTimes(1);
    expect(d.bridge.capturePane).toHaveBeenCalledTimes(3);
    expect(d.agent.waitUntilInputReady).toHaveBeenCalledTimes(2);
  });
  it("fails system reset when the next prompt is still pasted onto the reset command", async () => {
    const d = fakeDeps();
    d.bridge.capturePane = vi
      .fn()
      .mockResolvedValueOnce("› ")
      .mockResolvedValue("› /clear[Pasted Content 31220 chars]");

    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow("context reset command was not submitted before automation prompt");

    expect(d.bridge.sendRawKey).toHaveBeenCalledTimes(3);
    expect(d.bridge.capturePane).toHaveBeenCalledTimes(5);
  });

  it("blocks transcript browsing before reset or any blind rewind Enter", async () => {
    const d = fakeDeps();
    d.bridge.capturePane.mockResolvedValue(
      "/ T R A N S C R I P T /\n› prior WorkOrder\nBrowsing · ↵ rewind · esc back",
    );
    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow(/ambiguous.*input|transcript/i);
    expect(d.bridge.sendKeys).not.toHaveBeenCalled();
    expect(d.bridge.sendRawKey).not.toHaveBeenCalled();
  });

  it("blocks a transcript UI reached after reset without pressing Enter", async () => {
    const d = fakeDeps();
    d.bridge.capturePane
      .mockResolvedValueOnce("› \nContext 100% left")
      .mockResolvedValue("/ T R A N S C R I P T /\nBrowsing · ↵ rewind · esc back");
    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow(/ambiguous.*input|transcript/i);
    expect(d.bridge.sendKeys).toHaveBeenCalledOnce();
    expect(d.bridge.sendRawKey).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "Working on previous task",
    readFileSync(new URL("../fixtures/codex-update-pane.txt", import.meta.url), "utf8"),
    "› prior unsubmitted WorkOrder",
    "› \n• Queued follow-up inputs",
  ])("fails closed for an unverified input surface: %s", async (pane) => {
    const d = fakeDeps();
    d.bridge.capturePane.mockResolvedValue(pane);
    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow(/input surface/);
    expect(d.bridge.sendKeys).not.toHaveBeenCalled();
    expect(d.bridge.sendRawKey).not.toHaveBeenCalled();
  });

  it("fails closed when pane capture rejects", async () => {
    const d = fakeDeps();
    d.bridge.capturePane.mockRejectedValue(new Error("capture failed"));
    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow(/input surface/);
    expect(d.bridge.sendKeys).not.toHaveBeenCalled();
  });
  it.each(["Ask Codex to do anything", "Find and fix a bug in @filename"])(
    "accepts a colored muted idle placeholder: %s",
    async (placeholder) => {
      const d = fakeDeps();
      d.bridge.capturePane.mockResolvedValue(`› ${placeholder}`);
      d.bridge.capturePaneColored = vi.fn(async () => `\x1b[1m›\x1b[0m \x1b[2m${placeholder}`);
      await sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true });
      expect(d.bridge.sendKeys).toHaveBeenCalledOnce();
      expect(d.bridge.sendRawKey).not.toHaveBeenCalled();
    },
  );

  it("does not discard typed text that happens to equal the placeholder", async () => {
    const d = fakeDeps();
    d.bridge.capturePane.mockResolvedValue("› Ask Codex to do anything");
    d.bridge.capturePaneColored = vi.fn(async () => "› Ask Codex to do anything");
    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow(/input surface/);
    expect(d.bridge.sendKeys).not.toHaveBeenCalled();
  });

  it("rejects unmuted typed text following a muted hint", async () => {
    const d = fakeDeps();
    d.bridge.capturePane.mockResolvedValue("› hint typed task");
    d.bridge.capturePaneColored = vi.fn(async () => "› \x1b[2mhint \x1b[0mtyped task");
    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow(/input surface/);
    expect(d.bridge.sendKeys).not.toHaveBeenCalled();
  });
});
