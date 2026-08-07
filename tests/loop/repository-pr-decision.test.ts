import { describe, expect, it } from "vitest";
import {
  parseSupervisorFinalSummary,
  recoverNonTerminalPullRequestDecisions,
  repositoryPullRequestReviewDisposition,
} from "../../src/core/loop/final-summary-contract.js";
import type {
  LoopSupervisorFinalSummary,
  LoopWorkOrder,
} from "../../src/core/loop/work-order-contract.js";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    projectId: "repo-prs",
    actionsTaken: ["reviewed PR #1"],
    delegatedTasks: [],
    finalVerification: "passed",
    commits: [],
    followUps: [],
    pullRequestDecisions: [
      {
        number: 1,
        repository: "OctopusGarage/repo",
        outcome: "merged",
        evidence: ["required checks passed"],
        nextStep: "none",
      },
    ],
    ...overrides,
  };
}

describe("repository PR decision contract", () => {
  it("recovers explicit non-terminal decisions omitted from the JSON array", () => {
    const workOrder = {
      task: { kind: "repository-pull-request-review", repo: "YS-Insight/geo-backend" },
    } as LoopWorkOrder;
    const input = {
      ...summary({
        status: "blocked",
        pullRequestDecisions: undefined,
        actionsTaken: [
          "PR #16 reviewed; decision=retry because GitHub remains UNSTABLE",
          "PR #19 reviewed; decision=manual-review because mergeability is CONFLICTING",
        ],
        followUps: ["Retry PR #16 after checks settle"],
      }),
    } as unknown as LoopSupervisorFinalSummary;

    const recovered = recoverNonTerminalPullRequestDecisions(workOrder, input);

    expect(recovered.pullRequestDecisions).toEqual([
      {
        number: 16,
        repository: "YS-Insight/geo-backend",
        outcome: "retry",
        evidence: ["PR #16 reviewed; decision=retry because GitHub remains UNSTABLE"],
        nextStep: "Retry PR #16 after checks settle",
      },
      {
        number: 19,
        repository: "YS-Insight/geo-backend",
        outcome: "manual-review",
        evidence: ["PR #19 reviewed; decision=manual-review because mergeability is CONFLICTING"],
        nextStep: "re-evaluate this pull request on the next retry",
      },
    ]);
    expect(repositoryPullRequestReviewDisposition(recovered)).toBe("retry");
  });

  it("never infers terminal outcomes from action text", () => {
    const workOrder = {
      task: { kind: "repository-pull-request-review", repo: "YS-Insight/geo-backend" },
    } as LoopWorkOrder;
    const input = {
      ...summary({
        pullRequestDecisions: undefined,
        actionsTaken: ["PR #16 reviewed; decision=merged after checks passed"],
      }),
    } as unknown as LoopSupervisorFinalSummary;

    expect(recoverNonTerminalPullRequestDecisions(workOrder, input)).toBe(input);
  });

  it("parses terminal merge and close decisions", () => {
    const result = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-1]${JSON.stringify(
        summary({
          pullRequestDecisions: [
            summary().pullRequestDecisions[0],
            {
              number: 2,
              repository: "OctopusGarage/repo",
              outcome: "closed",
              reason: "obsolete",
              evidence: ["superseded by PR #1"],
              nextStep: "none",
            },
          ],
        }),
      )}`,
      "run-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(repositoryPullRequestReviewDisposition(result.summary)).toBe("completed");
  });

  it("normalizes a single evidence string in a supervisor decision", () => {
    const result = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-evidence]${JSON.stringify(
        summary({
          status: "blocked",
          pullRequestDecisions: [
            {
              number: 19,
              repository: "OctopusGarage/repo",
              outcome: "retry",
              evidence: "required checks are still pending",
              nextStep: "poll checks again",
            },
          ],
        }),
      )}`,
      "run-evidence",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.pullRequestDecisions?.[0]?.evidence).toEqual([
        "required checks are still pending",
      ]);
    }
  });

  it("rejects a close decision outside the allowlist", () => {
    const result = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-2]${JSON.stringify(
        summary({
          pullRequestDecisions: [
            {
              number: 1,
              repository: "OctopusGarage/repo",
              outcome: "closed",
              reason: "ci-failed",
              evidence: ["checks failed"],
              nextStep: "none",
            },
          ],
        }),
      )}`,
      "run-2",
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid-summary" });
  });

  it("classifies retry and manual review as non-completed dispositions", () => {
    const retry = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-3]${JSON.stringify(
        summary({
          status: "blocked",
          pullRequestDecisions: [
            {
              number: 1,
              repository: "OctopusGarage/repo",
              outcome: "retry",
              evidence: ["CI is still running"],
              nextStep: "poll checks after backoff",
            },
          ],
        }),
      )}`,
      "run-3",
    );
    const manual = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-4]${JSON.stringify(
        summary({
          status: "blocked",
          pullRequestDecisions: [
            {
              number: 1,
              repository: "OctopusGarage/repo",
              outcome: "manual-review",
              evidence: ["migration semantics require owner decision"],
              nextStep: "ask the repository owner to choose a migration policy",
            },
          ],
        }),
      )}`,
      "run-4",
    );

    expect(retry.ok && repositoryPullRequestReviewDisposition(retry.summary)).toBe("retry");
    expect(manual.ok && repositoryPullRequestReviewDisposition(manual.summary)).toBe(
      "manual-review",
    );
  });

  it("treats an empty decision set as a valid no-PR completion and missing decisions as invalid", () => {
    const empty = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-5]${JSON.stringify(summary({ pullRequestDecisions: [] }))}`,
      "run-5",
    );
    const missing = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-6]${JSON.stringify(summary({ pullRequestDecisions: undefined }))}`,
      "run-6",
    );

    expect(empty.ok && repositoryPullRequestReviewDisposition(empty.summary)).toBe("completed");
    expect(missing.ok && repositoryPullRequestReviewDisposition(missing.summary)).toBe("invalid");
  });

  it("rejects retry decisions without a concrete next step", () => {
    const result = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-7]${JSON.stringify(
        summary({
          pullRequestDecisions: [
            {
              number: 1,
              repository: "OctopusGarage/repo",
              outcome: "retry",
              evidence: ["worker capacity is temporarily full"],
              nextStep: "",
            },
          ],
        }),
      )}`,
      "run-7",
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid-summary" });
  });
});
