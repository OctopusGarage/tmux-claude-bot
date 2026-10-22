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

  it("keeps active delegated tasks out of the scheduled architecture job key", () => {
    const delegated = workOrder({
      task: { kind: "active-delegated-task" } as NonNullable<LoopWorkOrder["task"]>,
    });

    expect(loopWorkOrderJobKey(delegated)).toBe("project:active-delegated-task");
    expect(loopLedgerTaskId(delegated)).toBe("loop:project:active-delegated-task:123");
  });

  it("uses workspace job keys for recovered workspace task-family WorkOrders", () => {
    const workspaceWorkOrder = (task: NonNullable<LoopWorkOrder["task"]>): LoopWorkOrder =>
      workOrder({
        task,
        workspace: { root: "/repo/workspace", repositories: [] },
      } as Partial<LoopWorkOrder>);

    expect(
      loopWorkOrderJobKey(
        workspaceWorkOrder({
          kind: "bug-fix",
          maxRounds: 1,
          maxBugsPerRound: 1,
          requireRegressionTest: true,
        }),
      ),
    ).toBe("workspace:project:bug-fix");
    expect(
      loopWorkOrderJobKey(
        workspaceWorkOrder({
          kind: "test-coverage",
          targetCoverage: 80,
          maxRounds: 1,
          requireMeaningfulTests: true,
          allowIntegrationTests: true,
          allowSmokeTests: true,
          allowE2ETests: true,
          allowAiEvalTests: false,
        }),
      ),
    ).toBe("workspace:project:test-coverage");
    expect(
      loopLedgerTaskId(
        workspaceWorkOrder({
          kind: "pull-request-review",
          lookbackHours: 24,
          consecutivePasses: 1,
          autoMerge: false,
          mergeMethod: "squash",
        }),
      ),
    ).toBe("loop:workspace:project:pull-request-review:123");
  });

  it("retains failures and settles only clean completion as success", () => {
    expect(workerLeaseOutcome("completed", false)).toBe("success");
    expect(workerLeaseOutcome("completed", true)).toBe("failure");
    expect(workerLeaseOutcome("invalid-output", false)).toBe("failure");
  });
});
