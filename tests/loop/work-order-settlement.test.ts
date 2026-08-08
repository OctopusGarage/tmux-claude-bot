import { describe, expect, it } from "vitest";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import {
  loopLedgerTaskId,
  loopWorkOrderJobKey,
  workerLeaseOutcome,
} from "../../src/core/loop/work-order-settlement.js";

function workOrder(overrides: Partial<LoopWorkOrder> = {}): LoopWorkOrder {
  return {
    id: "run-1",
    projectId: "project",
    projectName: "Project",
    projectPath: "/tmp/project",
    agent: "codex",
    scheduledAt: 123,
    requiredFinalMarker: "[done]",
    ...overrides,
  } as LoopWorkOrder;
}

describe("Loop WorkOrder settlement", () => {
  it("uses one job key for workspace and repository review WorkOrders", () => {
    expect(loopWorkOrderJobKey(workOrder({ task: { kind: "workspace-architecture" } }))).toBe(
      "workspace:project:architecture",
    );
    expect(
      loopWorkOrderJobKey(
        workOrder({
          task: { kind: "repository-pull-request-review" } as NonNullable<LoopWorkOrder["task"]>,
        }),
      ),
    ).toBe("pr-review:project");
  });

  it("builds the ledger identity from the canonical WorkOrder job key", () => {
    expect(
      loopLedgerTaskId(
        workOrder({
          task: { kind: "security-maintenance" } as NonNullable<LoopWorkOrder["task"]>,
        }),
      ),
    ).toBe("loop:project:security-maintenance:123");
  });

  it("retains failures and settles only clean completion as success", () => {
    expect(workerLeaseOutcome("completed", false)).toBe("success");
    expect(workerLeaseOutcome("completed", true)).toBe("failure");
    expect(workerLeaseOutcome("invalid-output", false)).toBe("failure");
  });
});
