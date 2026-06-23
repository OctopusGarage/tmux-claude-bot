import { describe, expect, it, vi } from "vitest";
import { sendContextReset } from "../../src/core/command/context-reset.js";

function fakeDeps() {
  return {
    bridge: { sendKeys: vi.fn(async () => undefined) },
    configResolver: { invalidate: vi.fn() },
  } as any;
}

describe("sendContextReset", () => {
  it("sends /compact and invalidates the resolver", async () => {
    const d = fakeDeps();
    await sendContextReset(d, "tmux_proj_x", "compact");
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/compact", "tmux_proj_x");
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("tmux_proj_x");
  });
  it("sends /clear and invalidates the resolver", async () => {
    const d = fakeDeps();
    await sendContextReset(d, "s1", "clear");
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/clear", "s1");
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("s1");
  });
});
