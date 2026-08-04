import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEvalReportFromSupervisorSummary,
  parseEvalReport,
  readEvalReportFile,
  summarizeDeterministicGates,
} from "../../../src/core/eval/report.js";
import type { LoopSupervisorFinalSummary } from "../../../src/core/loop/work-order.js";

describe("eval report", () => {
  it("builds a worker-internal eval report from WorkOrder review evidence", () => {
    const summary: LoopSupervisorFinalSummary = {
      status: "completed",
      projectId: "tmux-claude-bot",
      actionsTaken: ["updated config command tests"],
      delegatedTasks: [],
      finalVerification: "passed",
      reviewGate: {
        preMutationReview: ["checked config command surface"],
        postMutationReview: ["verified docs and command behavior"],
        aiReview: "passed",
        deterministicGates: [
          {
            name: "config-command-contract",
            command: "npm test -- tests/config-command.test.ts",
            result: "passed",
            evidence: "12 tests passed",
          },
        ],
        decision: "pass",
        notes: ["No standalone evaluator runtime was created."],
        evidence: [
          {
            questionInvestigated: "Does the config command cover personal settings?",
            conclusion: "The command exposes safe read and allowlisted writes.",
            evidence: ["config show redacts secrets", "config set rejects unknown keys"],
            uncertainty: "No Lark setup path was changed.",
            recommendedNextStep: "Keep unsupported secret writes in setup flows.",
          },
        ],
      },
      learning: {
        regressionCandidates: ["config command personal setting contract"],
        capabilityEvalCandidates: ["multi-surface config parity"],
        monitorOrTraceCandidates: ["config mutation audit trail"],
        documentationCandidates: ["operator config guide"],
      },
      commits: ["abc123"],
      followUps: [],
    };

    const report = buildEvalReportFromSupervisorSummary({
      workOrderId: "run-1",
      taskId: "config-command-alignment",
      summary,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      taskId: "config-command-alignment",
      source: {
        kind: "work-order-final-summary",
        workOrderId: "run-1",
        projectId: "tmux-claude-bot",
      },
      executionBoundary: "worker-internal",
      outcome: {
        status: "passed",
        finalVerification: "passed",
        reviewDecision: "pass",
      },
      evidence: [
        {
          questionInvestigated: "Does the config command cover personal settings?",
          conclusion: "The command exposes safe read and allowlisted writes.",
        },
      ],
      deterministicGates: [
        {
          name: "config-command-contract",
          result: "passed",
          command: "npm test -- tests/config-command.test.ts",
          evidence: "12 tests passed",
        },
      ],
      learningCandidates: {
        regression: ["config command personal setting contract"],
        capability: ["multi-surface config parity"],
      },
    });
    expect(JSON.stringify(report)).not.toMatch(/evaluatorSession|evaluatorQueue|lease/i);
  });

  it("fails the eval report when any deterministic gate fails", () => {
    const summary: LoopSupervisorFinalSummary = {
      status: "completed",
      projectId: "tmux-claude-bot",
      actionsTaken: [],
      delegatedTasks: [],
      finalVerification: "passed",
      reviewGate: {
        preMutationReview: [],
        postMutationReview: [],
        aiReview: "passed",
        deterministicGates: [
          { name: "types", result: "passed" },
          { name: "local verify", result: "failed", evidence: "tsc failed" },
        ],
        decision: "pass",
        notes: [],
      },
      commits: [],
      followUps: [],
    };

    const report = buildEvalReportFromSupervisorSummary({ summary });

    expect(report.outcome).toMatchObject({
      status: "failed",
      reason: "deterministic-gate-failed",
    });
  });

  it("summarizes string and object deterministic gates without losing result state", () => {
    expect(
      summarizeDeterministicGates([
        "manual smoke passed",
        { name: "types", result: "not-run" },
        { name: "e2e", result: "skipped", evidence: "docs-only change" },
      ]),
    ).toEqual([
      { name: "manual smoke passed", result: "passed" },
      { name: "types", result: "not-run" },
      { name: "e2e", result: "skipped", evidence: "docs-only change" },
    ]);
  });

  it("reads and validates eval reports without accepting service-owned evaluator state", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-eval-report-"));
    const reportPath = join(dir, "eval-report.json");
    const report = buildEvalReportFromSupervisorSummary({
      workOrderId: "run-2",
      taskId: "security-maintenance",
      summary: {
        status: "completed",
        projectId: "tmux-claude-bot",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "passed",
        reviewGate: {
          preMutationReview: [],
          postMutationReview: [],
          aiReview: "not-applicable",
          deterministicGates: ["smoke passed"],
          decision: "pass",
          notes: [],
        },
        commits: [],
        followUps: [],
      },
    });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    expect(readEvalReportFile(reportPath)).toEqual({ ok: true, report });
    expect(
      parseEvalReport({
        ...report,
        executionBoundary: "bot-managed-evaluator",
        evaluatorSession: "tmux_proj_loop-evaluator",
      }),
    ).toEqual({ ok: false, reason: "invalid-report" });
  });
});
