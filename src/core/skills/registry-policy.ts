import type { ApprovedSkill, SkillCatalogEntry } from "./schema.js";

type InstalledAgentSkillProjection = {
  skillId: string;
  sourceUrl: string;
  sourcePath?: string;
  ref: string;
  checksum: string;
  platforms: Array<"claude" | "codex">;
  tags: string[];
  trustLevel: "core" | "approved" | "community";
  risk: "low" | "medium" | "high";
  updatePolicy: "manual" | "notify" | "auto-minor";
  status: "installed" | "quarantined";
  installedAt: number;
  updatedAt?: number;
};

type AgentSkillResolvedVersionProjection = {
  ref: string;
  checksum: string;
};

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function approvedSkillSpecsEqual(left: ApprovedSkill, right: ApprovedSkill): boolean {
  return (
    left.id === right.id &&
    left.sourceUrl === right.sourceUrl &&
    left.sourcePath === right.sourcePath &&
    left.ref === right.ref &&
    left.checksum === right.checksum &&
    sameStringArray(left.platforms, right.platforms) &&
    sameStringArray(left.tags, right.tags) &&
    left.trustLevel === right.trustLevel &&
    left.risk === right.risk &&
    left.updatePolicy === right.updatePolicy
  );
}

export function installedSkillMatchesApprovedSkill(
  installed: InstalledAgentSkillProjection,
  spec: ApprovedSkill,
): boolean {
  return approvedSkillSpecsEqual(
    {
      id: installed.skillId,
      sourceUrl: installed.sourceUrl,
      sourcePath: installed.sourcePath,
      ref: installed.ref,
      checksum: installed.checksum,
      platforms: installed.platforms,
      tags: installed.tags,
      trustLevel: installed.trustLevel,
      risk: installed.risk,
      updatePolicy: installed.updatePolicy,
    },
    spec,
  );
}

export function installedFromApprovedSkill(
  spec: ApprovedSkill,
  now: number,
  previous?: InstalledAgentSkillProjection,
  status: InstalledAgentSkillProjection["status"] = "installed",
): InstalledAgentSkillProjection {
  return {
    skillId: spec.id,
    sourceUrl: spec.sourceUrl,
    ...(spec.sourcePath !== undefined ? { sourcePath: spec.sourcePath } : {}),
    ref: spec.ref,
    checksum: spec.checksum,
    platforms: spec.platforms,
    tags: spec.tags,
    trustLevel: spec.trustLevel,
    risk: spec.risk,
    updatePolicy: spec.updatePolicy,
    status,
    installedAt: previous?.installedAt ?? now,
    ...(previous !== undefined ? { updatedAt: now } : {}),
  };
}

export function approvedFromCatalogEntry(
  skill: SkillCatalogEntry,
  version: AgentSkillResolvedVersionProjection,
): ApprovedSkill {
  return {
    id: skill.id,
    sourceUrl: skill.sourceUrl,
    sourcePath: skill.sourcePath,
    ref: version.ref,
    checksum: version.checksum,
    platforms: skill.platforms,
    tags: skill.tags,
    trustLevel: skill.trustLevel,
    risk: skill.risk,
    updatePolicy: skill.updatePolicy,
  };
}
