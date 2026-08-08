import { describe, expect, it } from "vitest";
import { reconcileTerminalSupervisorResources } from "../../src/core/loop/supervisor-resource-reconciliation.js";

describe("supervisor resource reconciliation", () => {
  it("returns an empty reconciliation summary when no supervisor resources are terminal", () => {
    expect(reconcileTerminalSupervisorResources({ now: 2_000 })).toEqual({
      settledTerminalLeases: 0,
      abandonedWorkOrders: 0,
      removedTerminalWorktrees: 0,
      removedExpiredWorktrees: 0,
    });
  });
});
