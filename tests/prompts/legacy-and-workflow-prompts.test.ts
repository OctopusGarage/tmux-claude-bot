import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { governedPromptById } from "../../src/core/prompts/registry.js";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("legacy and workflow prompt governance", () => {
  it("keeps legacy loop prompt metadata explicit and bounded", () => {
    const legacyPrompts = [
      governedPromptById("legacy.loop.agent-eval"),
      governedPromptById("legacy.loop.agent-task"),
      governedPromptById("legacy.loop.preflight-repair"),
      governedPromptById("legacy.loop.dirty-worktree-recovery"),
      governedPromptById("legacy.loop.verification-recovery"),
      governedPromptById("legacy.loop.post-commit-dirty-recovery"),
    ];

    expect(legacyPrompts.map((prompt) => prompt.legacy)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(governedPromptById("legacy.loop.agent-eval").actionScope).toBe("read-only");
    for (const prompt of legacyPrompts.filter((prompt) => prompt.actionScope !== "read-only")) {
      expect(prompt.actionScope).toBe("commit");
      expect(prompt.riskLevel).toBe("high");
    }
  });

  it("keeps legacy loop runtime prompts inside the governed source file", () => {
    const source = read("src/core/loop/run.ts");

    expect(source).toContain("function buildAgentEvalPrompt");
    expect(source).toContain("function buildAgentTaskPrompt");
    expect(source).toContain("function buildPreflightRepairPrompt");
    expect(source).toContain("function buildDirtyWorktreeRecoveryPrompt");
    expect(source).toContain("function buildVerificationRecoveryPrompt");
    expect(source).toContain("function buildPostCommitDirtyRecoveryPrompt");
  });

  it("keeps operator workflow prompts registered with read-only boundaries where required", () => {
    const finder = governedPromptById("workflow.audit.finder");
    const verifier = governedPromptById("workflow.audit.verifier");
    const archLoop = governedPromptById("workflow.arch-loop");

    expect(finder).toMatchObject({
      owner: ".claude/workflows/audit.mjs",
      actionScope: "read-only",
      evalExpectation: "docs-only",
    });
    expect(verifier).toMatchObject({
      owner: ".claude/workflows/audit.mjs",
      actionScope: "read-only",
      evalExpectation: "docs-only",
    });
    expect(archLoop).toMatchObject({
      owner: ".agents/skills/arch-loop/SKILL.md",
      actionScope: "commit",
      evalExpectation: "docs-only",
    });
  });

  it("keeps workflow prompt sources discoverable for docs-only eval", () => {
    const auditWorkflow = read(".claude/workflows/audit.mjs");
    const archLoopSkill = read(".agents/skills/arch-loop/SKILL.md");

    expect(auditWorkflow).toContain("audit");
    expect(archLoopSkill).toContain("architecture");
    expect(archLoopSkill).toContain("score");
  });
});
