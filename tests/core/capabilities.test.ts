import { describe, expect, it } from "vitest";
import {
  capabilityById,
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

  it("recognizes installed capability skills from registry records", () => {
    const status = capabilityStatusForTaskFamily("architecture", [
      {
        skillId: "improve-codebase-architecture",
        sourceUrl: "https://github.com/mattpocock/skills",
        sourcePath: "skills/engineering/improve-codebase-architecture",
        ref: "2ab958093e83e0ec752e6c1c5932da465bf23e0c",
        checksum: "sha256:installed",
        platforms: ["claude", "codex"],
        tags: ["architecture"],
        trustLevel: "approved",
        risk: "medium",
        updatePolicy: "notify",
        status: "installed",
        installedAt: 1,
      },
    ]);

    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
          installed: true,
          blocking: false,
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

  it("plans keep actions for already installed default capabilities", () => {
    const installedSkillIds = defaultApprovedSkills().map((skill) => skill.id);
    const plan = capabilityInstallPlan({
      scope: "default",
      installedSkillIds,
    });

    expect(plan.actions.every((action) => action.action === "keep")).toBe(true);
    expect(plan.actions.map((action) => action.skillId).sort()).toEqual(installedSkillIds);
  });

  it("returns undefined for unknown capability identifiers", () => {
    expect(capabilityById("skill:unknown")).toBeUndefined();
  });
});
