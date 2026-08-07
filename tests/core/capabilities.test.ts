import { describe, expect, it } from "vitest";
import {
  capabilityInstallPlan,
  capabilityStatusForTaskFamily,
  DEFAULT_CAPABILITY_CATALOG,
  defaultApprovedSkills,
  taskFamilyCapabilityDependencies,
} from "../../src/core/capabilities/catalog.js";
import {
  LOOP_TASK_FAMILY_GOVERNANCE,
  LOOP_WORK_ORDER_TASK_KINDS,
} from "../../src/core/loop/task-family.js";

describe("capability catalog", () => {
  it("declares architecture skill dependencies as task-family capabilities", () => {
    const dependencies = taskFamilyCapabilityDependencies("architecture");

    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
          level: "recommended",
          phase: "assessment",
        }),
      ]),
    );
  });

  it("keeps every task family connected to capability dependency metadata", () => {
    for (const kind of LOOP_WORK_ORDER_TASK_KINDS) {
      expect(
        LOOP_TASK_FAMILY_GOVERNANCE[kind].capabilities,
        `${kind} must declare capability dependencies explicitly, even when empty`,
      ).toBeDefined();
    }
  });

  it("renders a missing recommended capability as a non-blocking install recommendation", () => {
    const status = capabilityStatusForTaskFamily("architecture", []);

    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
          installed: false,
          blocking: false,
          installHint: expect.stringContaining("tcb loop skills sync"),
        }),
      ]),
    );
  });

  it("builds a default approved skill list from installable skill capabilities", () => {
    const approved = defaultApprovedSkills();

    expect(approved.map((skill) => skill.id)).toContain("improve-codebase-architecture");
    expect(
      approved.every((skill) => !["main", "master", "HEAD", "latest"].includes(skill.ref)),
    ).toBe(true);
  });

  it("plans default capability installation without mutating third-party files directly", () => {
    const plan = capabilityInstallPlan({
      scope: "default",
      installedSkillIds: [],
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "install",
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
        }),
      ]),
    );
    expect(plan.approvedSkills.length).toBeGreaterThan(0);
    expect(DEFAULT_CAPABILITY_CATALOG.every((capability) => capability.source === "external")).toBe(
      true,
    );
  });
});
