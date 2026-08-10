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

  it("does not fail the eval report for a repaired preflight observation", () => {
    const report = buildEvalReportFromSupervisorSummary({
      summary: summary({
        reviewGate: {
          preMutationReview: ["local Node tools were initially missing"],
          postMutationReview: ["npm ci restored local tooling and final checks passed"],
          aiReview: "not-applicable",
          deterministicGates: [
            {
              name: "preflight-before-repair",
              command: "test -d node_modules && test -x node_modules/.bin/tsc",
              result: "failed",
              evidence: "node_modules and tool binaries were absent",
            },
            {
              name: "environment-repair",
              command: "npm ci",
              result: "passed",
              evidence: "installed dependencies without tracked changes",
            },
            {
              name: "preflight-after-repair",
              command: "test -d node_modules && test -x node_modules/.bin/tsc",
              result: "passed",
              evidence: "required tool binaries are executable",
            },
            {
              name: "typecheck",
              command: "npm run lint:types",
              result: "passed",
              evidence: "tsc --noEmit exited 0",
            },
          ],
          decision: "pass",
          notes: ["The failed preflight was repaired before final verification."],
        },
      }),
    });

    expect(report.outcome).toMatchObject({
      status: "passed",
      finalVerification: "passed",
      reviewDecision: "pass",
    });
  });

  it("accepts repaired preflight observations without a before-repair label", () => {
    const report = buildEvalReportFromSupervisorSummary({
      summary: summary({
        reviewGate: {
          preMutationReview: ["initial tool preflight failed"],
          postMutationReview: [
            "npm install repaired dependencies and post-repair preflight passed",
          ],
          aiReview: "not-applicable",
          deterministicGates: [
            {
              name: "preflight",
              command: "test -x node_modules/.bin/vitest",
              result: "failed",
              evidence: "vitest executable was absent",
            },
            {
              name: "environment repair",
              command: "npm install",
              result: "passed",
              evidence: "dependency installation completed",
            },
            {
              name: "post-repair preflight",
              command: "test -x node_modules/.bin/vitest",
              result: "passed",
              evidence: "preflight passed after repair",
            },
          ],
          decision: "pass",
          notes: [],
        },
      }),
    });

    expect(report.outcome).toMatchObject({
      status: "passed",
      finalVerification: "passed",
      reviewDecision: "pass",
    });
  });

  it("does not fail eval for a protected-worktree base switch observation superseded by safe reset", () => {
    const report = buildEvalReportFromSupervisorSummary({
      summary: summary({
        reviewGate: {
          preMutationReview: ["checked isolated worktree before mutation"],
          postMutationReview: [
            "No product-code mutation occurred; only ignored local environment state was created.",
          ],
          aiReview: "passed",
          deterministicGates: [
            {
              name: "fetch origin main",
              command: "git fetch origin main",
              result: "passed",
              evidence: "Fetched origin/main.",
            },
            {
              name: "literal switch-main base sync",
              command: "git -C <expected-worktree> switch main",
              result: "failed",
              evidence:
                "Git failed with `fatal: 'main' is already checked out at '/repo/knowledge-engine'`; the original worktree was not mutated.",
            },
            {
              name: "safe work-order branch reset",
              command: "git switch -C <work-order-branch> origin/main",
              result: "passed",
              evidence: "WorkOrder branch reset to origin/main.",
            },
            {
              name: "base freshness",
              command: "git rev-parse HEAD origin/main",
              result: "passed",
              evidence: "HEAD matched origin/main.",
            },
            {
              name: "final clean worktree",
              command: "git status --short",
              result: "passed",
              evidence: "No tracked diff.",
            },
          ],
          decision: "pass",
          notes: [
            "The literal `git switch main` instruction remains incompatible with the protected original worktree already checking out main. Freshness was established by fetch plus resetting the WorkOrder branch from origin/main.",
          ],
        },
      }),
    });

    expect(report.outcome).toMatchObject({
      status: "passed",
      finalVerification: "passed",
      reviewDecision: "pass",
    });
  });

  it("does not fail eval for a source-worktree control check excluded from final acceptance", () => {
    const report = buildEvalReportFromSupervisorSummary({
      summary: summary({
        reviewGate: {
          preMutationReview: ["verified prior evidence in the isolated worktree"],
          postMutationReview: [
            "Regression risk: npm run verify:local passed in the isolated worktree; no runtime behavior changed because no source patch was made.",
          ],
          aiReview: "passed",
          deterministicGates: [
            {
              name: "local verification",
              command: "npm run verify:local",
              result: "passed",
              evidence: "verify-local ok",
            },
            {
              name: "ordinary source CLI control check",
              command:
                "TCB_STATE_DIR=... /repo/tmux-claude-bot/node_modules/.bin/tsx /repo/tmux-claude-bot/src/cli.ts dashboard --json",
              result: "failed",
              evidence:
                "Failed to transform unrelated reserved source worktree file src/core/loop/service.ts because 'await' can only be used inside an async function. This was not used for final acceptance because this WorkOrder forbids source-worktree mutation.",
            },
            {
              name: "isolated CLI control check",
              command: "node_modules/.bin/tsx src/cli.ts dashboard --json",
              result: "passed",
              evidence: "Dashboard command passed in the isolated worktree.",
            },
            {
              name: "clean isolated worktree",
              command: "git status --short",
              result: "passed",
              evidence: "No tracked diff.",
            },
          ],
          decision: "pass",
          notes: [
            "The ordinary source worktree currently contains unrelated uncommitted changes and a TypeScript syntax error. It was checked only as external risk context and was not mutated.",
          ],
        },
      }),
    });

    expect(report.outcome).toMatchObject({
      status: "passed",
      finalVerification: "passed",
      reviewDecision: "pass",
    });
  });

  it("does not fail the eval report for an architecture target residual after bounded verified work", () => {
    const report = buildEvalReportFromSupervisorSummary({
      summary: summary({
        reviewGate: {
          preMutationReview: ["confirmed bounded architecture slice"],
          postMutationReview: ["typecheck, tests, CI, PR mergeability, and merge gates passed"],
          aiReview: "passed",
          deterministicGates: [
            {
              name: "round verification typecheck",
              command: "pnpm run typecheck",
              result: "passed",
              evidence: "exit 0",
            },
            {
              name: "round verification tests",
              command: "pnpm test",
              result: "passed",
              evidence: "all tests passed",
            },
            {
              name: "architecture assessment",
              command: "node $LOOP_BOT_ROOT/scripts/loop-architecture-assess.mjs",
              result: "failed",
              evidence: "score remained 85 after maxRounds=3, target 95 not met",
            },
            {
              name: "PR merge",
              command: "gh pr merge 20 --auto --squash",
              result: "passed",
              evidence: "PR state MERGED",
            },
          ],
          decision: "pass",
          notes: [
            "Deterministic code/test/CI/merge gates passed, but target architecture score was not met within maxRounds. This is recorded as remaining risk rather than hidden.",
          ],
        },
      }),
    });

    expect(report.outcome).toMatchObject({
      status: "passed",
      finalVerification: "passed",
      reviewDecision: "pass",
    });
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
