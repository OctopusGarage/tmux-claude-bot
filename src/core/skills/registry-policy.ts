import type { AgentSkillResolvedVersion, InstalledAgentSkill } from "./registry.js";
import type { ApprovedSkill, SkillCatalogEntry } from "./schema.js";

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
  installed: InstalledAgentSkill,
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
  previous?: InstalledAgentSkill,
  status: InstalledAgentSkill["status"] = "installed",
): InstalledAgentSkill {
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
  version: AgentSkillResolvedVersion,
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
