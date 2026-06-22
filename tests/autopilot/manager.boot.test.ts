import { describe, expect, it, vi } from "vitest";
import { startAutopilot } from "../../src/core/autopilot/manager.js";

function deps(tickMs: number) {
  return {
    config: { autopilot: { tickMs } },
    activity: { onActivity: vi.fn(() => () => {}) },
    bridge: { listProjectSessions: async () => [] },
  } as never;
}

describe("startAutopilot master switch", () => {
  it("AUTOPILOT_TICK_MS=0 → no subscription, no-op stop", () => {
    const d = deps(0);
    const stop = startAutopilot(d);
    expect(
      (d as never as { activity: { onActivity: ReturnType<typeof vi.fn> } }).activity.onActivity,
    ).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("tickMs>0 → subscribes to activity", () => {
    const d = deps(8000);
    const stop = startAutopilot(d);
    expect(
      (d as never as { activity: { onActivity: ReturnType<typeof vi.fn> } }).activity.onActivity,
    ).toHaveBeenCalledOnce();
    stop();
  });
});
