import type { ApprovedSkill } from "../skills/schema.js";

export type CapabilityType = "skill" | "mcp" | "cli" | "prompt-rubric";
export type CapabilitySource = "repo-bundled" | "external" | "system";
export type CapabilityInstallScope = "global" | "operator-home" | "project" | "not-installed";
export type CapabilityDependencyLevel = "required" | "recommended" | "optional";

export type CapabilityDefinition = {
  id: string;
  type: CapabilityType;
  source: CapabilitySource;
  title: string;
  description: string;
  installScope: CapabilityInstallScope;
  tags: string[];
  approvedSkill?: ApprovedSkill;
};

export type TaskCapabilityDependency = {
  capabilityId: string;
  level: CapabilityDependencyLevel;
  phase: "assessment" | "planning" | "execution" | "review" | "eval";
  reason: string;
};
