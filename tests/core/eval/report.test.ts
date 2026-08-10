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
  function summary(
    overrides: Partial<LoopSupervisorFinalSummary> = {},
  ): LoopSupervisorFinalSummary {
    return {
      status: "completed",
      projectId: "tmux-claude-bot",
      actionsTaken: [],
      delegatedTasks: [],
      finalVerification: "passed",
      commits: [],
      followUps: [],
      ...overrides,
    };
  }

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

  it("passes completed recoveries after hyphenated dependency preflight before repair failures", () => {
    const summary: LoopSupervisorFinalSummary = {
      status: "completed",
      projectId: "english-pilot",
      actionsTaken: ["restored local toolchain and reran verification"],
      delegatedTasks: [],
      finalVerification: "passed",
      reviewGate: {
        preMutationReview: [],
        postMutationReview: ["dependency restore completed and tests passed"],
        aiReview: "passed",
        deterministicGates: [
          {
            name: "preflight-before-repair",
            result: "failed",
            command: "npm test",
            evidence:
              "node_modules/.bin/vitest tool binaries were missing during dependency preflight",
          },
          {
            name: "preflight",
            result: "passed",
            command: "npm test",
            evidence: "verification passed after environment repair",
          },
        ],
        decision: "pass",
        notes: [],
      },
      commits: ["abc123"],
      followUps: [],
    };

    const report = buildEvalReportFromSupervisorSummary({ summary });

    expect(report.outcome).toMatchObject({
      status: "passed",
      finalVerification: "passed",
      reviewDecision: "pass",
    });
    expect(report.outcome.reason).toBeUndefined();
  });

  it("maps supervisor review and verification states to eval outcomes", () => {
    const fail = buildEvalReportFromSupervisorSummary({
      summary: summary({
        reviewGate: {
          preMutationReview: [],
          postMutationReview: [],
          aiReview: "failed",
          deterministicGates: [],
          decision: "fail",
          notes: [],
        },
      }),
    });
    const block = buildEvalReportFromSupervisorSummary({
      summary: summary({
        reviewGate: {
          preMutationReview: [],
          postMutationReview: [],
          aiReview: "passed",
          deterministicGates: [],
          decision: "block",
          notes: [],
        },
      }),
    });
    const finalFailed = buildEvalReportFromSupervisorSummary({
      summary: summary({ finalVerification: "failed" }),
    });
    const supervisorBlocked = buildEvalReportFromSupervisorSummary({
      summary: summary({ status: "blocked", finalVerification: "unknown" }),
    });
    const verificationNotRun = buildEvalReportFromSupervisorSummary({
      summary: summary({ finalVerification: "not-run" }),
    });
    const unknown = buildEvalReportFromSupervisorSummary({
      summary: summary({ status: "timeout", finalVerification: "unknown" }),
    });

    expect(fail.outcome).toMatchObject({
      status: "failed",
      reviewDecision: "fail",
      reason: "review-gate-failed",
    });
    expect(block.outcome).toMatchObject({
      status: "blocked",
      reviewDecision: "block",
      reason: "review-gate-blocked",
    });
    expect(finalFailed.outcome).toMatchObject({
      status: "failed",
      reason: "final-verification-failed",
    });
    expect(supervisorBlocked.outcome).toMatchObject({
      status: "blocked",
      reason: "supervisor-blocked",
    });
    expect(verificationNotRun.outcome).toMatchObject({
      status: "not-run",
      reason: "verification-not-run",
    });
    expect(unknown.outcome).toMatchObject({
      status: "unknown",
      reason: "insufficient-eval-signal",
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

  it("rejects malformed eval report sections and missing report files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-eval-report-invalid-"));
    const invalidPath = join(dir, "eval-report.json");
    writeFileSync(invalidPath, "{", "utf8");
    const valid = buildEvalReportFromSupervisorSummary({ summary: summary() });

    expect(readEvalReportFile(undefined)).toEqual({ ok: false, reason: "missing-report" });
    expect(readEvalReportFile(join(dir, "missing.json"))).toEqual({
      ok: false,
      reason: "missing-report",
    });
    expect(readEvalReportFile(invalidPath)).toEqual({ ok: false, reason: "invalid-report" });
    expect(parseEvalReport(null)).toEqual({ ok: false, reason: "invalid-report" });
    expect(parseEvalReport({ ...valid, schemaVersion: 2 })).toEqual({
      ok: false,
      reason: "invalid-report",
    });
    expect(parseEvalReport({ ...valid, taskId: 42 })).toEqual({
      ok: false,
      reason: "invalid-report",
    });
    expect(parseEvalReport({ ...valid, source: { kind: "other", projectId: "repo" } })).toEqual({
      ok: false,
      reason: "invalid-report",
    });
    expect(parseEvalReport({ ...valid, outcome: { status: "passed" } })).toEqual({
      ok: false,
      reason: "invalid-report",
    });
    expect(
      parseEvalReport({ ...valid, evidence: [{ questionInvestigated: "missing fields" }] }),
    ).toEqual({
      ok: false,
      reason: "invalid-report",
    });
    expect(
      parseEvalReport({ ...valid, deterministicGates: [{ name: "types", result: "bad" }] }),
    ).toEqual({
      ok: false,
      reason: "invalid-report",
    });
    expect(parseEvalReport({ ...valid, notes: ["ok", 42] })).toEqual({
      ok: false,
      reason: "invalid-report",
    });
    expect(parseEvalReport({ ...valid, learningCandidates: { regression: [] } })).toEqual({
      ok: false,
      reason: "invalid-report",
    });
  });
});
