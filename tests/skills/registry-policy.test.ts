import { describe, expect, it } from "vitest";
import type { InstalledAgentSkill } from "../../src/core/skills/registry.js";
import {
  approvedFromCatalogEntry,
  installedFromApprovedSkill,
  installedSkillMatchesApprovedSkill,
} from "../../src/core/skills/registry-policy.js";
import type { ApprovedSkill, SkillCatalogEntry } from "../../src/core/skills/schema.js";

const approved = {
  id: "improve-codebase-architecture",
  sourceUrl: "https://github.com/mattpocock/skills",
  sourcePath: "skills/engineering/improve-codebase-architecture",
  ref: "2f3c4d5e6a",
  checksum: "sha256:abc",
  platforms: ["claude", "codex"],
  tags: ["architecture"],
  trustLevel: "approved",
  risk: "medium",
  updatePolicy: "notify",
} satisfies ApprovedSkill;

describe("registry policy", () => {
  it("projects approved skills into installed registry records", () => {
    expect(installedFromApprovedSkill(approved, 1_234)).toEqual({
      skillId: "improve-codebase-architecture",
      sourceUrl: approved.sourceUrl,
      sourcePath: approved.sourcePath,
      ref: approved.ref,
      checksum: approved.checksum,
      platforms: approved.platforms,
      tags: approved.tags,
      trustLevel: approved.trustLevel,
      risk: approved.risk,
      updatePolicy: approved.updatePolicy,
      status: "installed",
      installedAt: 1_234,
    });
  });

  it("compares the complete approved metadata surface", () => {
    const installed = installedFromApprovedSkill(approved, 1_234) satisfies InstalledAgentSkill;

    expect(installedSkillMatchesApprovedSkill(installed, approved)).toBe(true);
    expect(
      installedSkillMatchesApprovedSkill(installed, {
        ...approved,
        tags: ["architecture", "audit"],
      }),
    ).toBe(false);
  });

  it("projects catalog entries and resolved versions into approved specs", () => {
    const catalog = {
      id: "improve-codebase-architecture",
      sourceUrl: approved.sourceUrl,
      sourcePath: approved.sourcePath,
      trackingRef: "main",
      platforms: ["claude", "codex"],
      tags: ["architecture"],
      trustLevel: "approved",
      risk: "medium",
      updatePolicy: "notify",
    } satisfies SkillCatalogEntry;

    expect(approvedFromCatalogEntry(catalog, { ref: "resolved", checksum: "sha256:new" })).toEqual({
      ...approved,
      ref: "resolved",
      checksum: "sha256:new",
    });
  });
});
