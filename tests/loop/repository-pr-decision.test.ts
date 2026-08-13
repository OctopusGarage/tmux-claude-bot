import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  finalMarkerForWorkOrder,
  parseSupervisorFinalSummary,
  parseSupervisorFinalSummaryFile,
  recoverNonTerminalPullRequestDecisions,
  repositoryPullRequestReviewDisposition,
  validateSupervisorFinalSummaryForWorkOrder,
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
  it("builds the required supervisor final marker for a work order", () => {
    expect(finalMarkerForWorkOrder("work-order-42")).toBe("[LOOP_SUPERVISOR_DONE:work-order-42]");
  });

  it("parses the final summary after the last matching marker", () => {
    const result = parseSupervisorFinalSummary(
      [
        `[LOOP_SUPERVISOR_DONE:run-last]${JSON.stringify({ status: "unknown" })}`,
        "intermediate retry output",
        `[LOOP_SUPERVISOR_DONE:run-last]${JSON.stringify(
          summary({ actionsTaken: [{ merged: { pr: 1, result: "complete" } }] }),
        )}`,
      ].join("\n"),
      "run-last",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.actionsTaken).toEqual(["merged: pr=1; result=complete"]);
    }
  });

  it("reports missing and malformed supervisor final summaries distinctly", () => {
    expect(parseSupervisorFinalSummary("no completion marker", "run-missing")).toEqual({
      ok: false,
      reason: "missing-final-marker",
    });
    expect(
      parseSupervisorFinalSummary("[LOOP_SUPERVISOR_DONE:run-empty] no json", "run-empty"),
    ).toEqual({
      ok: false,
      reason: "invalid-summary",
    });
    expect(parseSupervisorFinalSummary("[LOOP_SUPERVISOR_DONE:run-bad]{", "run-bad")).toEqual({
      ok: false,
      reason: "invalid-summary",
    });
  });

  it("normalizes legacy supervisor summary fields without weakening the contract", () => {
    const result = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-legacy]${JSON.stringify(
        summary({
          status: "complete",
          actionsTaken: [
            {
              audit: {
                files: ["src/core/loop/final-summary-contract.ts"],
                changed: false,
              },
            },
          ],
          delegatedTasks: [
            "checked current worktree",
            { projectId: "repo-prs", status: "completed" },
            { round: 2, task: "verify local", result: "passed" },
            { result: "reported final state" },
          ],
          finalVerification: { command: "npm run verify:local", result: "passed" },
          reviewGate: {
            preMutationReview: [],
            postMutationReview: ["reviewed diff"],
            aiReview: "not-applicable",
            deterministicGates: [
              "npm test",
              {
                name: "verify local",
                command: "npm run verify:local",
                evidence: "exit 0",
                result: "passed",
              },
            ],
            decision: "pass",
            notes: { reviewer: "codex", result: "accepted" },
            evidence: [
              {
                questionInvestigated: "Does the summary preserve durable evidence?",
                conclusion: "yes",
                evidence: "contract test",
                uncertainty: "low",
                recommendedNextStep: "keep parser strict",
              },
            ],
          },
          planReview: {
            checklistCompleted: ["scope reviewed"],
            targetScoreMet: "not-applicable: parsing-only contract",
            stopConditionReached: "coverage slice complete",
            overOptimizationAvoided: true,
            verificationCompleted: "not-run",
            remainingRisks: "none",
          },
          learning: {
            regressionCandidates: [],
            capabilityEvalCandidates: [],
            monitorOrTraceCandidates: [],
            documentationCandidates: ["document final marker contract"],
          },
        }),
      )}`,
      "run-legacy",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.status).toBe("completed");
      expect(result.summary.actionsTaken).toEqual([
        "audit: files=src/core/loop/final-summary-contract.ts; changed=false",
      ]);
      expect(result.summary.delegatedTasks).toEqual([
        "checked current worktree",
        { projectId: "repo-prs", status: "completed" },
        "Round 2: verify local Result: passed",
        "Delegated task Result: reported final state",
      ]);
      expect(result.summary.finalVerification).toBe("passed");
      expect(result.summary.reviewGate?.notes).toEqual(["reviewer=codex; result=accepted"]);
      expect(result.summary.reviewGate?.deterministicGates).toEqual([
        "npm test",
        {
          name: "verify local",
          command: "npm run verify:local",
          evidence: "exit 0",
          result: "passed",
        },
      ]);
      expect(result.summary.reviewGate?.evidence?.[0]?.evidence).toEqual(["contract test"]);
      expect(result.summary.planReview).toMatchObject({
        checklistCompleted: true,
        targetScoreMet: "not-applicable",
        stopConditionReached: true,
        verificationCompleted: false,
        remainingRisks: ["none"],
      });
      expect(result.summary.learning?.documentationCandidates).toEqual([
        "document final marker contract",
      ]);
    }
  });

  it("extracts the first balanced JSON summary after the marker without being confused by string braces", () => {
    const result = parseSupervisorFinalSummary(
      [
        "supervisor preface",
        `[LOOP_SUPERVISOR_DONE:run-json] ${JSON.stringify(
          summary({
            actionsTaken: [
              'inspected object text {"not":"a boundary"} and escaped quote \\" safely',
            ],
            followUps: ["keep trailing objects out of the parsed summary"],
          }),
        )} {"ignored": true}`,
      ].join("\n"),
      "run-json",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.actionsTaken[0]).toContain('{"not":"a boundary"}');
      expect(result.summary.followUps).toEqual(["keep trailing objects out of the parsed summary"]);
    }
  });

  it("derives final verification from structured legacy objects according to terminal status", () => {
    const completed = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-completed]${JSON.stringify(
        summary({ status: "completed", finalVerification: { command: "verify", exitCode: 0 } }),
      )}`,
      "run-completed",
    );
    const failed = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-failed]${JSON.stringify(
        summary({ status: "failed", finalVerification: { command: "verify", exitCode: 1 } }),
      )}`,
      "run-failed",
    );
    const blocked = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-blocked]${JSON.stringify(
        summary({ status: "blocked", finalVerification: { command: "verify", exitCode: null } }),
      )}`,
      "run-blocked",
    );

    expect(completed.ok && completed.summary.finalVerification).toBe("passed");
    expect(failed.ok && failed.summary.finalVerification).toBe("failed");
    expect(blocked.ok && blocked.summary.finalVerification).toBe("unknown");
  });

  it("normalizes multi-field legacy action records into deterministic evidence strings", () => {
    const result = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-actions]${JSON.stringify(
        summary({
          actionsTaken: [
            {
              changed: true,
              files: ["src/core/loop/final-summary-contract.ts", "tests/loop"],
              notes: null,
            },
          ],
        }),
      )}`,
      "run-actions",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.actionsTaken).toEqual([
        "changed=true; files=src/core/loop/final-summary-contract.ts, tests/loop; notes=null",
      ]);
    }
  });

  it("rejects malformed optional review, plan, learning, and delegation sections", () => {
    const invalidSummaries = [
      summary({ delegatedTasks: [{ projectId: "repo-prs", status: "" }] }),
      summary({
        reviewGate: {
          preMutationReview: [],
          postMutationReview: [],
          aiReview: "skipped",
          deterministicGates: [],
          decision: "pass",
          notes: [],
        },
      }),
      summary({
        planReview: {
          checklistCompleted: [],
          targetScoreMet: "unknown",
          stopConditionReached: "",
          overOptimizationAvoided: true,
          verificationCompleted: "done",
          remainingRisks: [],
        },
      }),
      summary({
        learning: {
          regressionCandidates: [],
          capabilityEvalCandidates: [],
          monitorOrTraceCandidates: [],
          documentationCandidates: [42],
        },
      }),
    ];

    for (const [index, invalidSummary] of invalidSummaries.entries()) {
      expect(
        parseSupervisorFinalSummary(
          `[LOOP_SUPERVISOR_DONE:run-invalid-${index}]${JSON.stringify(invalidSummary)}`,
          `run-invalid-${index}`,
        ),
      ).toEqual({ ok: false, reason: "invalid-summary" });
    }
  });

  it("parses valid file summaries and rejects absent or invalid summary files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-final-summary-"));
    const validPath = join(dir, "valid.json");
    const invalidPath = join(dir, "invalid.json");
    writeFileSync(validPath, JSON.stringify(summary()), "utf8");
    writeFileSync(invalidPath, "{", "utf8");

    expect(
      parseSupervisorFinalSummaryFile({ finalSummaryPath: validPath } as LoopWorkOrder),
    ).toEqual({
      ok: true,
      summary: summary(),
    });
    expect(
      parseSupervisorFinalSummaryFile({ finalSummaryPath: invalidPath } as LoopWorkOrder),
    ).toEqual({
      ok: false,
      reason: "invalid-summary",
    });
    expect(
      parseSupervisorFinalSummaryFile({
        finalSummaryPath: join(dir, "missing.json"),
      } as LoopWorkOrder),
    ).toEqual({
      ok: false,
      reason: "missing-final-marker",
    });
    expect(parseSupervisorFinalSummaryFile({} as LoopWorkOrder)).toEqual({
      ok: false,
      reason: "missing-final-marker",
    });
  });

  it("requires plan review evidence when a work order required planning", () => {
    const workOrder = { planning: { required: true } } as LoopWorkOrder;

    expect(
      validateSupervisorFinalSummaryForWorkOrder(
        workOrder,
        summary() as LoopSupervisorFinalSummary,
      ),
    ).toBe(false);
    expect(
      validateSupervisorFinalSummaryForWorkOrder(
        workOrder,
        summary({
          planReview: {
            checklistCompleted: true,
            targetScoreMet: "not-applicable",
            stopConditionReached: false,
            overOptimizationAvoided: true,
            verificationCompleted: true,
            remainingRisks: [],
          },
        }) as LoopSupervisorFinalSummary,
      ),
    ).toBe(true);
  });

  it("prevents repository PR review work orders from completing with retry-only decisions", () => {
    const workOrder = {
      task: { kind: "repository-pull-request-review", repo: "OctopusGarage/repo" },
    } as LoopWorkOrder;
    const retrySummary = summary({
      status: "completed",
      pullRequestDecisions: [
        {
          number: 1,
          repository: "OctopusGarage/repo",
          outcome: "retry",
          evidence: ["required checks are still pending"],
          nextStep: "retry after checks finish",
        },
      ],
    }) as LoopSupervisorFinalSummary;
    const blockedRetrySummary = {
      ...retrySummary,
      status: "blocked",
    } as LoopSupervisorFinalSummary;

    expect(validateSupervisorFinalSummaryForWorkOrder(workOrder, retrySummary)).toBe(false);
    expect(validateSupervisorFinalSummaryForWorkOrder(workOrder, blockedRetrySummary)).toBe(true);
  });

  it("does not recover omitted PR decisions when action lines are ambiguous", () => {
    const workOrder = {
      task: { kind: "repository-pull-request-review", repo: "YS-Insight/geo-backend" },
    } as LoopWorkOrder;
    const input = summary({
      status: "blocked",
      pullRequestDecisions: undefined,
      actionsTaken: [
        "PR #16 reviewed; decision=retry because checks are still running",
        "PR #16 reviewed; decision=manual-review because ownership is unclear",
      ],
    }) as unknown as LoopSupervisorFinalSummary;

    expect(recoverNonTerminalPullRequestDecisions(workOrder, input)).toBe(input);
  });

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

  it("rejects malformed pull request decision records at each contract boundary", () => {
    const invalidDecisions = [
      "not-an-array",
      [null],
      [
        {
          number: 0,
          repository: "OctopusGarage/repo",
          outcome: "retry",
          evidence: ["x"],
          nextStep: "y",
        },
      ],
      [{ number: 1, repository: "", outcome: "retry", evidence: ["x"], nextStep: "y" }],
      [
        {
          number: 1,
          repository: "OctopusGarage/repo",
          outcome: "unknown",
          evidence: ["x"],
          nextStep: "y",
        },
      ],
      [
        {
          number: 1,
          repository: "OctopusGarage/repo",
          outcome: "merged",
          reason: 42,
          evidence: ["checks passed"],
          nextStep: "none",
        },
      ],
      [
        {
          number: 1,
          repository: "OctopusGarage/repo",
          outcome: "closed",
          evidence: ["stale"],
          nextStep: "none",
        },
      ],
      [
        {
          number: 1,
          repository: "OctopusGarage/repo",
          outcome: "manual-review",
          evidence: [],
          nextStep: "ask owner",
        },
      ],
    ];

    for (const [index, pullRequestDecisions] of invalidDecisions.entries()) {
      expect(
        parseSupervisorFinalSummary(
          `[LOOP_SUPERVISOR_DONE:run-invalid-pr-${index}]${JSON.stringify(
            summary({ pullRequestDecisions }),
          )}`,
          `run-invalid-pr-${index}`,
        ),
      ).toMatchObject({ ok: false, reason: "invalid-summary" });
    }
  });

  it("classifies structurally impossible decision outcomes as invalid at the disposition boundary", () => {
    expect(
      repositoryPullRequestReviewDisposition({
        ...(summary() as LoopSupervisorFinalSummary),
        pullRequestDecisions: [
          {
            number: 1,
            repository: "OctopusGarage/repo",
            outcome: "approved" as never,
            evidence: ["not a terminal contract outcome"],
            nextStep: "none",
          },
        ],
      }),
    ).toBe("invalid");
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
              boundary: "migration-decision",
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

  it("requires a structured human boundary instead of inferring one from prose", () => {
    const permissionProse = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-permission-prose]${JSON.stringify(
        summary({
          status: "blocked",
          pullRequestDecisions: [
            {
              number: 22,
              repository: "OctopusGarage/fluent-frame",
              outcome: "manual-review",
              evidence: [
                "workflow conclusion is action_required even though the configured actor has admin permission",
              ],
              nextStep: "retry after the system repairs the workflow policy",
            },
          ],
        }),
      )}`,
      "run-permission-prose",
    );
    const explicitBoundary = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-explicit-boundary]${JSON.stringify(
        summary({
          status: "blocked",
          pullRequestDecisions: [
            {
              number: 23,
              repository: "OctopusGarage/fluent-frame",
              outcome: "manual-review",
              boundary: "organization-policy",
              evidence: ["organization policy denies fork workflow execution"],
              nextStep: "ask an organization owner to change the policy",
            },
          ],
        }),
      )}`,
      "run-explicit-boundary",
    );

    expect(
      permissionProse.ok && repositoryPullRequestReviewDisposition(permissionProse.summary),
    ).toBe("retry");
    expect(
      explicitBoundary.ok && repositoryPullRequestReviewDisposition(explicitBoundary.summary),
    ).toBe("manual-review");
  });

  it("rejects unknown boundaries and boundaries attached to non-manual decisions", () => {
    for (const [runId, pullRequestDecisions] of [
      [
        "unknown-boundary",
        [
          {
            number: 22,
            repository: "OctopusGarage/fluent-frame",
            outcome: "manual-review",
            boundary: "github-is-weird",
            evidence: ["unknown boundary"],
            nextStep: "ask a human",
          },
        ],
      ],
      [
        "retry-boundary",
        [
          {
            number: 22,
            repository: "OctopusGarage/fluent-frame",
            outcome: "retry",
            boundary: "organization-policy",
            evidence: ["transient failure"],
            nextStep: "retry",
          },
        ],
      ],
    ] as const) {
      expect(
        parseSupervisorFinalSummary(
          `[LOOP_SUPERVISOR_DONE:${runId}]${JSON.stringify(summary({ pullRequestDecisions }))}`,
          runId,
        ),
      ).toMatchObject({ ok: false, reason: "invalid-summary" });
    }
  });

  it("downgrades generic architecture review to retry instead of a human terminal", () => {
    const result = parseSupervisorFinalSummary(
      `[LOOP_SUPERVISOR_DONE:run-architecture-review]${JSON.stringify(
        summary({
          status: "blocked",
          pullRequestDecisions: [
            {
              number: 85,
              repository: "OctopusGarage/tmux-claude-bot",
              outcome: "manual-review",
              evidence: [
                "A large architectural extraction requires human architectural/design review.",
              ],
              nextStep: "The owner must review the architecture before conflict repair.",
            },
          ],
        }),
      )}`,
      "run-architecture-review",
    );

    expect(result.ok && repositoryPullRequestReviewDisposition(result.summary)).toBe("retry");
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
