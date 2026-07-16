import { z } from "zod";

export const skillIdSchema = z.string().min(1);
export type SkillId = z.infer<typeof skillIdSchema>;

export const skillAgentSchema = z.enum(["claude", "codex"]);
export type SkillAgent = z.infer<typeof skillAgentSchema>;

export const skillTrustLevelSchema = z.enum(["core", "approved", "community"]);
export type SkillTrustLevel = z.infer<typeof skillTrustLevelSchema>;

export const skillRiskSchema = z.enum(["low", "medium", "high"]);
export type SkillRisk = z.infer<typeof skillRiskSchema>;

export const skillUpdatePolicySchema = z.enum(["manual", "notify", "auto-minor"]);
export type SkillUpdatePolicy = z.infer<typeof skillUpdatePolicySchema>;

export const approvedSkillSchema = z.object({
  id: skillIdSchema,
  sourceUrl: z.string().url(),
  sourcePath: z.string().min(1).optional(),
  ref: z.string().min(1),
  checksum: z.string().min(1),
  platforms: z.array(skillAgentSchema).min(1),
  tags: z.array(z.string().min(1)).default([]),
  trustLevel: skillTrustLevelSchema,
  risk: skillRiskSchema,
  updatePolicy: skillUpdatePolicySchema,
});
export type ApprovedSkill = z.infer<typeof approvedSkillSchema>;

export const skillCatalogEntrySchema = z.object({
  id: skillIdSchema,
  sourceUrl: z.string().url(),
  sourcePath: z.string().min(1),
  trackingRef: z.string().min(1),
  platforms: z.array(skillAgentSchema).min(1),
  tags: z.array(z.string().min(1)).default([]),
  trustLevel: skillTrustLevelSchema,
  risk: skillRiskSchema,
  updatePolicy: skillUpdatePolicySchema,
});
export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;
