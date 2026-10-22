import { describe, expect, it, vi } from "vitest";
import { readProtectedWork } from "../../src/core/power/protected-work.js";

describe("protected work evidence", () => {
  it("treats pending or running user prompts as protected and short-circuits probes", async () => {
    const busyAgentSessions = vi.fn(async () => ["unused"]);
    await expect(
      readProtectedWork({
        queueHasWork: () => true,
        unfinishedWorkOrderCount: () => 0,
        activeLeaseCount: () => 0,
        busyAgentSessions,
      }),
    ).resolves.toEqual({ active: true, reasons: ["message-queue"] });
    expect(busyAgentSessions).not.toHaveBeenCalled();
  });

  it("protects unfinished work orders and active worker leases", async () => {
    await expect(
      readProtectedWork({
        queueHasWork: () => false,
        unfinishedWorkOrderCount: () => 2,
        activeLeaseCount: () => 1,
        busyAgentSessions: async () => [],
      }),
    ).resolves.toEqual({
      active: true,
      reasons: ["work-orders:2", "worker-leases:1"],
    });
  });

  it("uses active agent evidence after durable and queue evidence is clear", async () => {
    await expect(
      readProtectedWork({
        queueHasWork: () => false,
        unfinishedWorkOrderCount: () => 0,
        activeLeaseCount: () => 0,
        busyAgentSessions: async () => ["tmux_proj_active"],
      }),
    ).resolves.toEqual({ active: true, reasons: ["agent:tmux_proj_active"] });
  });

  it("reports idle only when every evidence source is clear", async () => {
    await expect(
      readProtectedWork({
        queueHasWork: () => false,
        unfinishedWorkOrderCount: () => 0,
        activeLeaseCount: () => 0,
        busyAgentSessions: async () => [],
      }),
    ).resolves.toEqual({ active: false, reasons: [] });
  });
});
