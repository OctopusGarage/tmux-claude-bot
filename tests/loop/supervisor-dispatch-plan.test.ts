import { describe, expect, it } from "vitest";
import type { LoopDueTarget } from "../../src/core/loop/supervisor-dispatch-plan.js";
import { planLoopSupervisorDispatch } from "../../src/core/loop/supervisor-dispatch-plan.js";

function target(input: {
  jobKey: string;
  jobKind: LoopDueTarget["due"]["jobKind"];
  projectPath: string;
  harnessTasks?: Array<{ kind: "architecture" | "bug-fix"; enabled: boolean }>;
}): LoopDueTarget {
  const base = {
    due: {
      projectId: input.jobKey,
      name: input.jobKey,
      jobKey: input.jobKey,
      jobKind: input.jobKind,
      scheduledAt: 1_000,
      effectiveAt: 1_000,
      jitterMs: 0,
      action: "would-run" as const,
    },
    projectPath: input.projectPath,
  };
  if (input.harnessTasks === undefined) return base;
  return {
    ...base,
    project: {
      harnessAuto: { tasks: input.harnessTasks },
    } as NonNullable<LoopDueTarget["project"]>,
  };
}

describe("planLoopSupervisorDispatch", () => {
  it("lets a harness claim its resources before a covered due target", () => {
    const architecture = target({
      jobKey: "architecture",
      jobKind: "architecture",
      projectPath: "/repo/app",
    });
    const harness = target({
      jobKey: "harness",
      jobKind: "harness-auto",
      projectPath: "/repo/app",
      harnessTasks: [{ kind: "architecture", enabled: true }],
    });

    const plan = planLoopSupervisorDispatch({
      targets: [architecture, harness],
      activeResourcePaths: new Set(),
    });

    expect(plan.ready).toEqual([harness]);
    expect(plan.skipped).toEqual([
      { target: architecture, reason: "harness harness-auto covers architecture" },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("keeps independent targets in due order while deferring active resource conflicts", () => {
    const blocked = target({
      jobKey: "blocked",
      jobKind: "architecture",
      projectPath: "/repo/busy",
    });
    const firstReady = target({
      jobKey: "first",
      jobKind: "bug-fix",
      projectPath: "/repo/first",
    });
    const secondReady = target({
      jobKey: "second",
      jobKind: "architecture",
      projectPath: "/repo/second",
    });

    const plan = planLoopSupervisorDispatch({
      targets: [blocked, firstReady, secondReady],
      activeResourcePaths: new Set(["/repo/busy"]),
    });

    expect(plan.ready).toEqual([firstReady, secondReady]);
    expect(plan.deferred).toEqual([
      {
        target: blocked,
        reason: "target overlaps active loop supervisor work",
        conflictsWith: ["active-work"],
      },
    ]);
  });
});
