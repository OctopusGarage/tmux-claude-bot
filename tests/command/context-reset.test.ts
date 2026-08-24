import { describe, expect, it, vi } from "vitest";
import { sendContextReset } from "../../src/core/command/context-reset.js";

function fakeDeps() {
  return {
    bridge: { sendKeys: vi.fn(async () => undefined), sendRawKey: vi.fn(async () => undefined) },
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
  it("can confirm reset submission before automation sends the next prompt", async () => {
    const d = fakeDeps();
    await sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true });
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/clear", "s1");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("C-m", "s1");
    expect(d.agent.waitUntilInputReady).toHaveBeenCalledTimes(2);
  });
  it("keeps confirming while the reset command remains in the active composer", async () => {
    const d = fakeDeps();
    d.bridge.capturePane = vi
      .fn()
      .mockResolvedValueOnce("› /clear\nmain · Context 100% left")
      .mockResolvedValueOnce("› \nmain · Context 100% left");

    await sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true });

    expect(d.bridge.sendRawKey).toHaveBeenCalledTimes(2);
    expect(d.bridge.capturePane).toHaveBeenCalledTimes(2);
    expect(d.agent.waitUntilInputReady).toHaveBeenCalledTimes(3);
  });
  it("fails system reset when the next prompt is still pasted onto the reset command", async () => {
    const d = fakeDeps();
    d.bridge.capturePane = vi.fn(async () => "› /clear[Pasted Content 31220 chars]");

    await expect(
      sendContextReset(d, "s1", "clear", { settleMs: 0, ensureSubmitted: true }),
    ).rejects.toThrow("context reset command was not submitted before automation prompt");

    expect(d.bridge.sendRawKey).toHaveBeenCalledTimes(3);
    expect(d.bridge.capturePane).toHaveBeenCalledTimes(3);
  });
});
