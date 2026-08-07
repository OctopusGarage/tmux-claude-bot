import { LOOP_TASK_FAMILY_GOVERNANCE, type LoopWorkOrderTaskKind } from "../loop/task-family.js";
import { skillChecksum } from "../skills/checksum.js";
import type { InstalledAgentSkill } from "../skills/registry.js";
import type { ApprovedSkill } from "../skills/schema.js";
import type { CapabilityDefinition, TaskCapabilityDependency } from "./types.js";

const MATTPOCOCK_SKILLS_MAIN_REF = "2ab958093e83e0ec752e6c1c5932da465bf23e0c";

function approvedSkill(input: Omit<ApprovedSkill, "checksum">): ApprovedSkill {
  return {
    ...input,
    checksum: skillChecksum({
      id: input.id,
      sourceUrl: input.sourceUrl,
      sourcePath: input.sourcePath ?? "",
      ref: input.ref,
    }),
  };
}

export const DEFAULT_CAPABILITY_CATALOG: CapabilityDefinition[] = [
  {
    id: "skill:mattpocock:improve-codebase-architecture",
    type: "skill",
    source: "external",
    title: "Improve Codebase Architecture",
    description:
      "Architecture assessment skill used by architecture maintenance tasks when the active agent has it installed.",
    installScope: "global",
    tags: ["architecture", "refactor", "loop-engineering"],
    approvedSkill: approvedSkill({
      id: "improve-codebase-architecture",
      sourceUrl: "https://github.com/mattpocock/skills",
      sourcePath: "skills/engineering/improve-codebase-architecture",
      ref: MATTPOCOCK_SKILLS_MAIN_REF,
      platforms: ["claude", "codex"],
      tags: ["architecture", "refactor"],
      trustLevel: "approved",
      risk: "medium",
      updatePolicy: "notify",
    }),
  },
  {
    id: "skill:mattpocock:code-review",
    type: "skill",
    source: "external",
    title: "Code Review",
    description:
      "Review discipline skill that can strengthen pull-request and architecture review rounds when available.",
    installScope: "global",
    tags: ["review", "quality", "loop-engineering"],
    approvedSkill: approvedSkill({
      id: "code-review",
      sourceUrl: "https://github.com/mattpocock/skills",
      sourcePath: "skills/engineering/code-review",
      ref: MATTPOCOCK_SKILLS_MAIN_REF,
      platforms: ["claude", "codex"],
      tags: ["review", "quality"],
      trustLevel: "approved",
      risk: "low",
      updatePolicy: "notify",
    }),
  },
  {
    id: "skill:mattpocock:tdd",
    type: "skill",
    source: "external",
    title: "Test-Driven Development",
    description:
      "Test-first implementation discipline skill used to improve test-coverage task quality when available.",
    installScope: "global",
    tags: ["tests", "quality", "loop-engineering"],
    approvedSkill: approvedSkill({
      id: "tdd",
      sourceUrl: "https://github.com/mattpocock/skills",
      sourcePath: "skills/engineering/tdd",
      ref: MATTPOCOCK_SKILLS_MAIN_REF,
      platforms: ["claude", "codex"],
      tags: ["tests", "quality"],
      trustLevel: "approved",
      risk: "low",
      updatePolicy: "notify",
    }),
  },
];

const capabilitiesById = new Map(
  DEFAULT_CAPABILITY_CATALOG.map((capability) => [capability.id, capability]),
);

export type CapabilityStatus = {
  capabilityId: string;
  title: string;
  type: CapabilityDefinition["type"];
  level: TaskCapabilityDependency["level"];
  phase: TaskCapabilityDependency["phase"];
  installed: boolean;
  blocking: boolean;
  reason: string;
  installHint: string;
};

export type CapabilityInstallAction = {
  action: "install" | "keep" | "unsupported";
  capabilityId: string;
  skillId?: string;
  reason: string;
};

export type CapabilityInstallPlan = {
  scope: "default" | "all";
  actions: CapabilityInstallAction[];
  approvedSkills: ApprovedSkill[];
  nextCommands: string[];
};

export function capabilityById(id: string): CapabilityDefinition | undefined {
  return capabilitiesById.get(id);
}

export function taskFamilyCapabilityDependencies(
  kind: LoopWorkOrderTaskKind,
): TaskCapabilityDependency[] {
  return LOOP_TASK_FAMILY_GOVERNANCE[kind].capabilities;
}

export function defaultApprovedSkills(): ApprovedSkill[] {
  return DEFAULT_CAPABILITY_CATALOG.flatMap((capability) =>
    capability.approvedSkill === undefined ? [] : [capability.approvedSkill],
  ).sort((a, b) => a.id.localeCompare(b.id));
}

function installedSkillIdSet(skills: Array<InstalledAgentSkill | string>): Set<string> {
  return new Set(skills.map((skill) => (typeof skill === "string" ? skill : skill.skillId)));
}

export function capabilityStatusForTaskFamily(
  kind: LoopWorkOrderTaskKind,
  installedSkills: Array<InstalledAgentSkill | string>,
): CapabilityStatus[] {
  const installed = installedSkillIdSet(installedSkills);
  return taskFamilyCapabilityDependencies(kind).map((dependency) => {
    const capability = capabilityById(dependency.capabilityId);
    const skillId = capability?.approvedSkill?.id;
    const isInstalled = skillId !== undefined && installed.has(skillId);
    return {
      capabilityId: dependency.capabilityId,
      title: capability?.title ?? dependency.capabilityId,
      type: capability?.type ?? "skill",
      level: dependency.level,
      phase: dependency.phase,
      installed: isInstalled,
      blocking: dependency.level === "required" && !isInstalled,
      reason: dependency.reason,
      installHint:
        capability?.approvedSkill === undefined
          ? "No automatic installer is registered for this capability."
          : "Add the default approved skills to a Loop config, then run: tcb loop skills sync <file>",
    };
  });
}

export function capabilityInstallPlan(input: {
  scope: "default" | "all";
  installedSkillIds: string[];
}): CapabilityInstallPlan {
  const installed = new Set(input.installedSkillIds);
  const approvedSkills = defaultApprovedSkills();
  const actions = DEFAULT_CAPABILITY_CATALOG.map((capability): CapabilityInstallAction => {
    const skillId = capability.approvedSkill?.id;
    if (skillId === undefined) {
      return {
        action: "unsupported",
        capabilityId: capability.id,
        reason: "capability has no approved skill installer contract",
      };
    }
    if (installed.has(skillId)) {
      return {
        action: "keep",
        capabilityId: capability.id,
        skillId,
        reason: "approved skill is already recorded as installed",
      };
    }
    return {
      action: "install",
      capabilityId: capability.id,
      skillId,
      reason: "approved skill is missing from the local Loop skill registry",
    };
  });
  return {
    scope: input.scope,
    actions,
    approvedSkills,
    nextCommands: [
      "Write approvedSkills into skills.approved in the Loop config.",
      "Set skills.applyCommand to an explicit installer script reviewed by the operator.",
      "Run: tcb loop skills sync <file>",
      "Restart affected Claude Code / Codex sessions so newly installed skills are discoverable.",
    ],
  };
}
