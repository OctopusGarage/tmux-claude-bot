import { describe, expect, it } from "vitest";
import { resolveLoopPreDispatchAssessment } from "../../src/core/loop/pre-dispatch-assessment.js";
import type { LoopDueTarget } from "../../src/core/loop/supervisor-dispatch-plan.js";

function dueTarget(overrides: Partial<LoopDueTarget> = {}): LoopDueTarget {
  return {
    due: {
      projectId: "hub",
      name: "Hub",
      jobKey: "security-maintenance:hub",
      jobKind: "security-maintenance",
      scheduledAt: 1,
      effectiveAt: 1,
      jitterMs: 0,
      action: "would-run",
    } as LoopDueTarget["due"],
    project: {
      id: "hub",
      name: "Hub",
      path: "/repo/hub",
      agent: "codex",
      goal: "Improve architecture",
      targetScore: 95,
      maxRounds: 3,
      runner: { kind: "agent-supervised" },
      assessment: { command: "assess" },
      securityMaintenance: {
        riskAssessment: {
          command: "risk",
          actionThreshold: 70,
          criticalThreshold: 90,
        },
      },
    } as NonNullable<LoopDueTarget["project"]>,
    projectPath: "/repo/hub",
    ...overrides,
  };
}

describe("resolveLoopPreDispatchAssessment", () => {
  it("returns a runnable pre-dispatch assessment for actionable project security risk", () => {
    const result = resolveLoopPreDispatchAssessment({
      target: dueTarget(),
      botRoot: "/bot",
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({ riskScore: 82, findings: ["dependency CVE"] }),
        stderr: "",
      }),
    });

    expect(result).toEqual({
      decision: "run",
      assessment: {
        score: 82,
        targetScore: 70,
        decision: "run",
        notes: ["security action threshold=70", "critical threshold=90", "dependency CVE"],
      },
    });
  });

  it("returns a skip decision before dispatch when project architecture already meets target", () => {
    const result = resolveLoopPreDispatchAssessment({
      target: dueTarget({
        due: {
          projectId: "hub",
          name: "Hub",
          jobKey: "architecture:hub",
          jobKind: "architecture",
          scheduledAt: 1,
          effectiveAt: 1,
          jitterMs: 0,
          action: "would-run",
        } as LoopDueTarget["due"],
      }),
      botRoot: "/bot",
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({ score: 96, suggestedBotImprovements: ["already good"] }),
        stderr: "",
      }),
    });

    expect(result).toEqual({
      decision: "skip",
      status: "completed",
      repairStatus: "not-needed",
      summary:
        "project Architecture score 96 reached target 95; skipped before WorkOrder dispatch. already good",
    });
  });
});
