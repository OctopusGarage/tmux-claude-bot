import { describe, expect, it } from "vitest";
import { buildDailyAuditRepairPrompt } from "../../src/core/tasks/task-repair.js";

describe("buildDailyAuditRepairPrompt", () => {
  it("requires dev branch repair, evidence review, verification, and commit", () => {
    const prompt = buildDailyAuditRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      items: [
        {
          taskId: "radar:daily:failed",
          source: "radar-monitor",
          name: "daily radar",
          scheduledAt: Date.parse("2026-07-27T02:00:00Z"),
          status: "failed",
          error: "missing output",
          updatedAt: Date.parse("2026-07-27T02:05:00Z"),
        },
      ],
    });

    expect(prompt).toContain("Daily scheduled task audit repair.");
    expect(prompt).toContain("git switch dev");
    expect(prompt).toContain("git pull --ff-only origin dev");
    expect(prompt).toContain("Do not assume every failure is a code bug");
    expect(prompt.indexOf("Review the evidence")).toBeLessThan(
      prompt.indexOf("git pull --ff-only origin dev"),
    );
    expect(prompt).toContain("continue the evidence review and classification");
    expect(prompt).toContain("report the branch sync blocker separately");
    expect(prompt).toContain("Fix one failure at a time");
    expect(prompt).toContain("pre-mutation review");
    expect(prompt).toContain("post-mutation review");
    expect(prompt).toContain(
      "AI review/eval may be used only through the existing Claude Code / Codex control surface",
    );
    expect(prompt).toContain("deterministic gates remain authoritative");
    expect(prompt).toContain("npm run verify:local");
    expect(prompt).toContain("commit");
    expect(prompt).toContain("radar:daily:failed");
  });
});
