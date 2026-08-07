import { createHash } from "node:crypto";

export type SkillChecksumInput = {
  id: string;
  sourceUrl: string;
  sourcePath: string;
  ref: string;
};

export function skillChecksum(input: SkillChecksumInput): string {
  const hash = createHash("sha256")
    .update("loop-skill-v1")
    .update("\n")
    .update(input.id)
    .update("\n")
    .update(input.sourceUrl)
    .update("\n")
    .update(input.sourcePath)
    .update("\n")
    .update(input.ref)
    .digest("hex");
  return `sha256:${hash}`;
}
