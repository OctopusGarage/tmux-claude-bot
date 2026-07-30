import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recoverInvalidOutputFromFinalSummary } from "../../src/core/loop/final-summary-recovery.js";
import type { LoopSupervisedRunResult } from "../../src/core/loop/supervised-runner.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

function workOrder(finalSummaryPath: string): LoopWorkOrder {
  return {
    id: "1785403020345-tmux-claude-bot-active-delegate",
    projectId: "tmux-claude-bot",
    projectName: "tmux-claude-bot",
    projectPath: "/tmp/tmux-claude-bot",
    agent: "codex",
    scheduledAt: 1_785_403_020_345,
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1785403020345-tmux-claude-bot-active-delegate]",
    finalSummaryPath,
  } as LoopWorkOrder;
}

describe("final summary recovery", () => {
  it("converts invalid output into a completed result when a valid final summary file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-final-summary-recovery-"));
    const summaryPath = join(dir, "supervisor-final-summary.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      summaryPath,
      `${JSON.stringify({
        status: "completed",
        projectId: "tmux-claude-bot",
        actionsTaken: ["confirmed stale failure is already superseded"],
        delegatedTasks: [{ projectId: "tmux-claude-bot", status: "completed" }],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      })}\n`,
    );

    const recovered = recoverInvalidOutputFromFinalSummary(workOrder(summaryPath), {
      status: "invalid-output",
      reason: "missing-final-marker",
      output: "tmux output ended before the final marker was captured",
    });

    expect(recovered).toMatchObject({
      status: "completed",
      summary: {
        projectId: "tmux-claude-bot",
        finalVerification: "passed",
        actionsTaken: ["confirmed stale failure is already superseded"],
      },
    });
  });

  it("leaves invalid output unchanged when the final summary file is missing", () => {
    const original: LoopSupervisedRunResult = {
      status: "invalid-output",
      reason: "missing-final-marker",
      output: "no final summary",
    };

    expect(
      recoverInvalidOutputFromFinalSummary(workOrder("/tmp/missing-summary.json"), original),
    ).toBe(original);
  });
});
