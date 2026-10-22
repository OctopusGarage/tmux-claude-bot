import { describe, expect, it } from "vitest";
import { skillChecksum } from "../../src/core/skills/checksum.js";

describe("skillChecksum", () => {
  it("is stable for the skill identity fields", () => {
    const input = {
      id: "improve-codebase-architecture",
      sourceUrl: "https://github.com/mattpocock/skills",
      sourcePath: "skills/engineering/improve-codebase-architecture",
      ref: "2ab958093e83e0ec752e6c1c5932da465bf23e0c",
    };

    expect(skillChecksum(input)).toBe(
      "sha256:420fc964b30255cc60e6cb6a9517d9a25036c8db13d45a8377f1dd40e0be53e3",
    );
  });

  it.each([
    ["id", { id: "other-id" }],
    ["sourceUrl", { sourceUrl: "https://example.com/other-skills" }],
    ["sourcePath", { sourcePath: "skills/other" }],
    ["ref", { ref: "012345678901234567890123456789012345678a" }],
  ])("changes when %s changes", (_field, change) => {
    const input = {
      id: "skill-id",
      sourceUrl: "https://example.com/skills",
      sourcePath: "skills/example",
      ref: "0123456789012345678901234567890123456789",
    };

    expect(skillChecksum({ ...input, ...change })).not.toBe(skillChecksum(input));
  });
});
