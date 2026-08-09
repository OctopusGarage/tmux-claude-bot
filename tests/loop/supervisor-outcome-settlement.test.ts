import { describe, expect, it, vi } from "vitest";
import { settleSupervisorWorkOrderOutcome } from "../../src/core/loop/supervisor-outcome-settlement.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const workOrder = {
  id: "run-1",
  projectId: "project",
  projectName: "Project",
  projectPath: "/tmp/project",
  agent: "codex",
  scheduledAt: 100,
  requiredFinalMarker: "[done]",
} as LoopWorkOrder;

describe("supervisor WorkOrder outcome settlement", () => {
  it("settles completion through one durable state, lease, scheduler, and ledger protocol", () => {
    const state = vi.fn();
    const lease = vi.fn();
    const scheduler = { setLastFired: vi.fn() };
    const ledger = { expect: vi.fn(), start: vi.fn(), finish: vi.fn(), fail: vi.fn() };

    settleSupervisorWorkOrderOutcome({
      workOrder,
      supervisorSession: "supervisor",
      startedAt: 10,
      endedAt: 20,
      resultStatus: "completed",
      stateStatus: "completed",
      reportPath: "/tmp/report.md",
      summary: "changed module",
      advanceScheduler: true,
      writeState: state,
      settleLease: lease,
      scheduler,
      ledger,
    });

    expect(state).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect(lease).toHaveBeenCalledWith(workOrder, "completed", 20);
    expect(scheduler.setLastFired).toHaveBeenCalledWith("project", 100);
    expect(ledger.finish).toHaveBeenCalledWith(
      "loop:project:100",
      expect.objectContaining({ summary: "changed module", reportPath: "/tmp/report.md" }),
    );
    expect(ledger.fail).not.toHaveBeenCalled();
  });
});
