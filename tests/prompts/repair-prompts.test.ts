import { describe, expect, it } from "vitest";
import {
  buildDailyAuditRepairPrompt,
  buildResourceGuardianRepairPrompt,
  buildRuntimeGuardianRepairPrompt,
} from "../../src/core/prompts/repair-prompts.js";

describe("repair prompts", () => {
  it("keeps Daily Task Audit repair limited to tmux-claude-bot system issues", () => {
    const prompt = buildDailyAuditRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      items: [
        {
          taskId: "task-1",
          source: "daily-audit",
          name: "architecture",
          scheduledAt: 1,
          status: "failed",
          error: "missing notification",
          updatedAt: 2,
        },
      ],
    });

    expect(prompt).toContain("Daily scheduled task audit repair.");
    expect(prompt).toContain("tmux-claude-bot scheduling, supervisor, notification");
    expect(prompt).toContain("Do not edit code until the failure is independently confirmed");
    expect(prompt).toContain("target-project failure");
    expect(prompt).toContain("Do not change external project code");
    expect(prompt).toContain("pre-mutation review");
    expect(prompt).toContain("post-mutation review");
    expect(prompt).toContain("git pull --rebase origin dev");
    expect(prompt).toContain("npm run verify:local");
  });

  it("keeps Runtime Guardian repair limited to tmux-claude-bot runtime logic", () => {
    const prompt = buildRuntimeGuardianRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      mode: "fast-heal",
      findings: [
        {
          kind: "missing-system-gate",
          severity: "high",
          runId: "run-1",
          projectId: "target-project",
          projectPath: "/repo/target-project",
          evidence: ["missing system-gate.json"],
        },
      ],
    });

    expect(prompt).toContain("Runtime Guardian (fast-heal)");
    expect(prompt).toContain("Fix tmux-claude-bot system-layer/runtime orchestration issues only");
    expect(prompt).toContain("Do not edit target project repositories");
    expect(prompt).toContain("prove the issue is real");
    expect(prompt).toContain("pre-mutation review");
    expect(prompt).toContain("post-mutation review");
    expect(prompt).toContain("commit only verified fixes");
    expect(prompt).toContain("Do not open a PR");
    expect(prompt).toContain("source=runtime-guardian");
  });
});

describe("Resource Guardian repair prompt", () => {
  it("keeps stable recovery repair inside the bot repository with deterministic evidence", () => {
    const prompt = buildResourceGuardianRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      incident: { id: "incident-1", fingerprint: "load", evidence: ["owned process"] },
    });
    expect(prompt).toContain("Resource Guardian stable-recovery repair.");
    expect(prompt).toContain("never edit a target project");
    expect(prompt).toContain("rev-parse --show-toplevel");
    expect(prompt).toContain("Explore -> Plan -> Code -> Verify -> Review -> Record");
    expect(prompt).toContain("npm run verify:local");
    expect(prompt).toContain("Do not create or open a PR");
    expect(prompt).toContain(
      "Stop when the evidence does not prove a bot-owned reproducible defect",
    );
    expect(prompt).toContain("do not optimize, refactor, or broaden scope speculatively");
    expect(prompt).toContain("Commit only a verified, narrow repair");
    expect(prompt).toContain("pre-mutation reviewGate");
    expect(prompt).toContain("post-mutation reviewGate");
    expect(prompt).toContain(
      "regression, evaluation, monitoring, and documentation follow-up candidates",
    );
    expect(prompt).toContain("focused regression/eval/monitor/documentation candidate");
    expect(prompt).toContain("source=resource-guardian");
  });
});
