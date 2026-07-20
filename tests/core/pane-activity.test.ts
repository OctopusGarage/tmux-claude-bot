import { describe, expect, it, vi } from "vitest";
import { paneIsAnimating } from "../../src/core/session/pane-activity.js";

describe("paneIsAnimating", () => {
  it("detects a changing pane across two captures", async () => {
    const bridge = {
      capturePane: vi
        .fn()
        .mockResolvedValueOnce("thinking 0s")
        .mockResolvedValueOnce("thinking 1s"),
    };

    await expect(paneIsAnimating(bridge, "tmux_proj_api", 0)).resolves.toBe(true);

    expect(bridge.capturePane).toHaveBeenCalledTimes(2);
    expect(bridge.capturePane).toHaveBeenNthCalledWith(1, "tmux_proj_api");
    expect(bridge.capturePane).toHaveBeenNthCalledWith(2, "tmux_proj_api");
  });

  it("treats a static pane as idle", async () => {
    const bridge = {
      capturePane: vi.fn().mockResolvedValue("ready"),
    };

    await expect(paneIsAnimating(bridge, "tmux_proj_api", 0)).resolves.toBe(false);
  });

  it("treats capture failures as not animating", async () => {
    const bridge = {
      capturePane: vi.fn().mockRejectedValueOnce(new Error("tmux missing")),
    };

    await expect(paneIsAnimating(bridge, "tmux_proj_api", 0)).resolves.toBe(false);

    expect(bridge.capturePane).toHaveBeenCalledTimes(1);
  });
});
