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
});
