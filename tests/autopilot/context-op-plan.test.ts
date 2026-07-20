import { describe, expect, it } from "vitest";
import { planPendingContextOp } from "../../src/core/autopilot/context-op-plan.js";
import { defaultState } from "../../src/core/autopilot/types.js";

describe("planPendingContextOp", () => {
  it("does nothing when no between-goals context op is pending", () => {
    expect(planPendingContextOp(defaultState(), true)).toEqual({ kind: "none" });
  });

  it("waits while the session is still busy", () => {
    expect(planPendingContextOp({ ...defaultState(), pendingContextOp: "compact" }, false)).toEqual(
      { kind: "wait" },
    );
  });

  it("plans the pending context reset when the session is idle", () => {
    expect(planPendingContextOp({ ...defaultState(), pendingContextOp: "clear" }, true)).toEqual({
      kind: "run",
      op: "clear",
    });
  });
});
