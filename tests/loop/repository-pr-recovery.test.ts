import { describe, expect, it } from "vitest";
import {
  createRepositoryPullRequestRecoveryController,
  planRepositoryPullRequestRecovery,
  type RepositoryPullRequestObservation,
} from "../../src/core/loop/repository-pr-recovery.js";
import type { LoopSupervisorFinalSummary } from "../../src/core/loop/work-order-contract.js";

function observation(
  overrides: Partial<RepositoryPullRequestObservation> = {},
): RepositoryPullRequestObservation {
  return {
    repository: "OctopusGarage/fluent-frame",
    number: 22,
    state: "open",
    headSha: "abc123",
    headRepository: "OctopusGarage/fluent-frame",
    baseRepository: "OctopusGarage/fluent-frame",
    isDraft: false,
    mergeable: "conflicting",
    mergeStateStatus: "dirty",
    repositoryPrivate: true,
    actor: "example-owner",
    actorPermission: "admin",
    workflowRuns: [],
    ...overrides,
  };
}

describe("repository PR recovery policy", () => {
  it("repairs private fork workflow policy without granting write tokens or secrets", () => {
    const plan = planRepositoryPullRequestRecovery(
      observation({
        workflowRuns: [
          { id: 101, headSha: "abc123", status: "completed", conclusion: "action_required" },
        ],
        forkWorkflowPolicy: {
          runWorkflowsFromForkPullRequests: false,
          sendWriteTokensToWorkflows: false,
          sendSecretsAndVariables: false,
          requireApprovalForForkPrWorkflows: false,
        },
      }),
    );

    expect(plan).toEqual({
      kind: "repair",
      reason: "private fork workflows are disabled for an action-required head run",
      actions: [
        {
          kind: "configure-private-fork-workflows",
          policy: {
            runWorkflowsFromForkPullRequests: true,
            sendWriteTokensToWorkflows: false,
            sendSecretsAndVariables: false,
            requireApprovalForForkPrWorkflows: false,
          },
        },
        { kind: "rerun-workflow", runId: 101 },
      ],
    });
  });

  it("reruns an action-required private workflow when the safe policy is already installed", () => {
    expect(
      planRepositoryPullRequestRecovery(
        observation({
          workflowRuns: [
            { id: 102, headSha: "abc123", status: "completed", conclusion: "action_required" },
          ],
          forkWorkflowPolicy: {
            runWorkflowsFromForkPullRequests: true,
            sendWriteTokensToWorkflows: false,
            sendSecretsAndVariables: false,
            requireApprovalForForkPrWorkflows: false,
          },
        }),
      ),
    ).toMatchObject({ kind: "repair", actions: [{ kind: "rerun-workflow", runId: 102 }] });
  });

  it("approves a public fork workflow and never approves a stale head run", () => {
    expect(
      planRepositoryPullRequestRecovery(
        observation({
          repositoryPrivate: false,
          headRepository: "contributor/fluent-frame",
          workflowRuns: [
            { id: 200, headSha: "old", status: "completed", conclusion: "action_required" },
            { id: 201, headSha: "abc123", status: "completed", conclusion: "action_required" },
          ],
        }),
      ),
    ).toMatchObject({ kind: "repair", actions: [{ kind: "approve-workflow", runId: 201 }] });
  });

  it("marks a reviewed clean draft ready only when the reviewed head matches", () => {
    expect(
      planRepositoryPullRequestRecovery(
        observation({
          isDraft: true,
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          workflowRuns: [
            { id: 300, headSha: "abc123", status: "completed", conclusion: "success" },
          ],
        }),
        {
          outcome: "approved",
          reviewedHeadSha: "abc123",
        },
      ),
    ).toEqual({
      kind: "repair",
      reason: "reviewed draft pull request is ready for review",
      actions: [{ kind: "mark-ready" }],
    });

    expect(
      planRepositoryPullRequestRecovery(
        observation({
          headSha: "def456",
          isDraft: true,
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          workflowRuns: [
            { id: 301, headSha: "def456", status: "completed", conclusion: "success" },
          ],
        }),
        {
          outcome: "approved",
          reviewedHeadSha: "abc123",
        },
      ),
    ).toMatchObject({ kind: "retry", reason: expect.stringContaining("reviewed head") });
  });

  it("keeps conflicts, drafts, pending checks, and transient observations retryable", () => {
    expect(planRepositoryPullRequestRecovery(observation())).toMatchObject({
      kind: "retry",
      reason: expect.stringContaining("conflict"),
    });
    expect(
      planRepositoryPullRequestRecovery(
        observation({ isDraft: true, mergeable: "mergeable", mergeStateStatus: "clean" }),
      ),
    ).toMatchObject({ kind: "retry", reason: expect.stringContaining("review") });
    expect(
      planRepositoryPullRequestRecovery(
        observation({
          mergeable: "mergeable",
          mergeStateStatus: "blocked",
          workflowRuns: [{ id: 300, headSha: "abc123", status: "in_progress", conclusion: null }],
        }),
      ),
    ).toMatchObject({ kind: "retry", reason: expect.stringContaining("pending") });
    expect(
      planRepositoryPullRequestRecovery(
        observation({
          isDraft: true,
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          workflowRuns: [
            { id: 301, headSha: "abc123", status: "completed", conclusion: "failure" },
          ],
        }),
        { outcome: "approved", reviewedHeadSha: "abc123" },
      ),
    ).toMatchObject({ kind: "retry", reason: expect.stringContaining("not passing") });
  });

  it("uses manual review only for an observed lack of repository authority", () => {
    expect(planRepositoryPullRequestRecovery(observation({ actorPermission: "read" }))).toEqual({
      kind: "manual-review",
      boundary: "ownership",
      reason: "configured GitHub actor lacks repository mutation authority",
    });
  });

  it("does nothing for terminal pull requests", () => {
    expect(planRepositoryPullRequestRecovery(observation({ state: "merged" }))).toEqual({
      kind: "none",
      reason: "pull request is already merged",
    });
    expect(planRepositoryPullRequestRecovery(observation({ state: "closed" }))).toEqual({
      kind: "none",
      reason: "pull request is already closed",
    });
  });
});

describe("repository PR recovery controller", () => {
  const retrySummary: LoopSupervisorFinalSummary = {
    status: "blocked",
    projectId: "fluent-frame-all-prs",
    actionsTaken: [],
    delegatedTasks: [],
    finalVerification: "unknown",
    commits: [],
    followUps: [],
    pullRequestDecisions: [
      {
        number: 22,
        repository: "OctopusGarage/fluent-frame",
        outcome: "manual-review",
        evidence: ["workflow conclusion action_required; actor permission is admin"],
        nextStep: "retry after safe system repair",
      },
    ],
  };

  it("settles a historical false manual decision when the PR is already merged", () => {
    const controller = createRepositoryPullRequestRecoveryController({
      github: {
        observe: () => observation({ state: "merged" }),
        execute: () => ({ ok: true }),
      },
      evidence: {
        begin: () => ({ id: "unused" }),
        finish: () => {},
      },
    });

    expect(
      controller.recover(retrySummary, {
        account: "example-owner",
        cwd: "/repo/fluent-frame",
        now: 1000,
      }),
    ).toEqual({ disposition: "completed", openPullRequests: 0, repaired: 0 });
  });

  it("persists intent, revalidates the head, executes repairs, and returns retry", () => {
    const events: string[] = [];
    const controller = createRepositoryPullRequestRecoveryController({
      github: {
        observe: () => {
          events.push("observe");
          return observation({
            workflowRuns: [
              { id: 101, headSha: "abc123", status: "completed", conclusion: "action_required" },
            ],
            forkWorkflowPolicy: {
              runWorkflowsFromForkPullRequests: true,
              sendWriteTokensToWorkflows: false,
              sendSecretsAndVariables: false,
              requireApprovalForForkPrWorkflows: false,
            },
          });
        },
        execute: (_target, action) => {
          events.push(`execute:${action.kind}`);
          return { ok: true };
        },
      },
      evidence: {
        begin: (input) => {
          events.push(`intent:${input.action}`);
          return { id: "intent-1" };
        },
        finish: (_id, input) => events.push(`outcome:${input.status}`),
      },
    });

    expect(
      controller.recover(retrySummary, {
        account: "example-owner",
        cwd: "/repo/fluent-frame",
        now: 1000,
      }),
    ).toMatchObject({ disposition: "retry", openPullRequests: 1, repaired: 1 });
    expect(events).toEqual([
      "observe",
      "observe",
      "intent:rerun-workflow",
      "execute:rerun-workflow",
      "outcome:succeeded",
    ]);
  });

  it("marks an approved reviewed draft ready through a durable recovery action", () => {
    const events: string[] = [];
    const controller = createRepositoryPullRequestRecoveryController({
      github: {
        observe: () => {
          events.push("observe");
          return observation({
            isDraft: true,
            mergeable: "mergeable",
            mergeStateStatus: "clean",
            workflowRuns: [
              { id: 301, headSha: "abc123", status: "completed", conclusion: "success" },
            ],
          });
        },
        execute: (_target, action) => {
          events.push(`execute:${action.kind}`);
          return { ok: true };
        },
      },
      evidence: {
        begin: (input) => {
          events.push(`intent:${input.action}`);
          return { id: "intent-ready" };
        },
        finish: (_id, input) => events.push(`outcome:${input.status}`),
      },
    });

    expect(
      controller.recover(
        {
          ...retrySummary,
          pullRequestDecisions: [
            {
              number: 22,
              repository: "OctopusGarage/fluent-frame",
              outcome: "approved",
              reviewedHeadSha: "abc123",
              evidence: ["reviewed diff, tests, checks, and mergeability"],
              nextStep: "mark ready for review",
            },
          ],
        },
        {
          account: "example-owner",
          cwd: "/repo/fluent-frame",
          now: 1000,
        },
      ),
    ).toMatchObject({ disposition: "retry", openPullRequests: 1, repaired: 1 });
    expect(events).toEqual([
      "observe",
      "observe",
      "intent:mark-ready",
      "execute:mark-ready",
      "outcome:succeeded",
    ]);
  });

  it("fails closed when durable intent cannot be written", () => {
    let executed = false;
    const controller = createRepositoryPullRequestRecoveryController({
      github: {
        observe: () =>
          observation({
            repositoryPrivate: false,
            workflowRuns: [
              { id: 201, headSha: "abc123", status: "completed", conclusion: "action_required" },
            ],
          }),
        execute: () => {
          executed = true;
          return { ok: true };
        },
      },
      evidence: {
        begin: () => {
          throw new Error("state unavailable");
        },
        finish: () => {},
      },
    });

    expect(() =>
      controller.recover(retrySummary, {
        account: "example-owner",
        cwd: "/repo/fluent-frame",
        now: 1000,
      }),
    ).toThrow("recovery intent persistence failed");
    expect(executed).toBe(false);
  });

  it("refuses observation and mutation when the configured project root is not trusted", () => {
    let observed = false;
    let executed = false;
    const controller = createRepositoryPullRequestRecoveryController({
      github: {
        observe: () => {
          observed = true;
          return observation();
        },
        execute: () => {
          executed = true;
          return { ok: true };
        },
      },
      evidence: {
        begin: () => ({ id: "unused" }),
        finish: () => {},
      },
      verifyTarget: () => false,
    });

    expect(() =>
      controller.recover(retrySummary, {
        account: "example-owner",
        cwd: "/wrong/repository",
        now: 1000,
      }),
    ).toThrow("configured project path is not its exact git top-level");
    expect(observed).toBe(false);
    expect(executed).toBe(false);
  });

  it("does not repeat a succeeded or in-flight durable recovery action after restart", () => {
    for (const status of ["succeeded", "intent"] as const) {
      let executed = false;
      const controller = createRepositoryPullRequestRecoveryController({
        github: {
          observe: () =>
            observation({
              repositoryPrivate: false,
              workflowRuns: [
                { id: 201, headSha: "abc123", status: "completed", conclusion: "action_required" },
              ],
            }),
          execute: () => {
            executed = true;
            return { ok: true };
          },
        },
        evidence: {
          begin: () => ({ id: "must-not-begin" }),
          finish: () => {},
          lookup: () => status,
        },
      });

      expect(
        controller.recover(retrySummary, {
          account: "example-owner",
          cwd: "/repo/fluent-frame",
          now: 1000,
        }),
      ).toMatchObject({ disposition: "retry", repaired: 0 });
      expect(executed).toBe(false);
    }
  });

  it("does not execute a stale action after the PR head or recovery plan changes", () => {
    let observed = 0;
    let executed = false;
    const controller = createRepositoryPullRequestRecoveryController({
      github: {
        observe: () => {
          observed += 1;
          return observation({
            headSha: observed === 1 ? "abc123" : "def456",
            repositoryPrivate: false,
            workflowRuns: [
              {
                id: 201,
                headSha: observed === 1 ? "abc123" : "def456",
                status: "completed",
                conclusion: observed === 1 ? "action_required" : "success",
              },
            ],
          });
        },
        execute: () => {
          executed = true;
          return { ok: true };
        },
      },
      evidence: {
        begin: () => ({ id: "unexpected" }),
        finish: () => {},
      },
    });

    expect(
      controller.recover(retrySummary, {
        account: "example-owner",
        cwd: "/repo/fluent-frame",
        now: 1000,
      }),
    ).toMatchObject({ disposition: "retry", repaired: 0 });
    expect(executed).toBe(false);
  });

  it("keeps a mixed batch retryable until every non-human decision is terminal", () => {
    const controller = createRepositoryPullRequestRecoveryController({
      github: {
        observe: ({ number }) =>
          observation({
            number,
            mergeable: "unknown",
            mergeStateStatus: "unknown",
          }),
        execute: () => ({ ok: true }),
      },
      evidence: {
        begin: () => ({ id: "unused" }),
        finish: () => {},
      },
    });
    const mixed: LoopSupervisorFinalSummary = {
      ...retrySummary,
      pullRequestDecisions: [
        {
          number: 22,
          repository: "OctopusGarage/fluent-frame",
          outcome: "retry",
          evidence: ["mergeability unknown"],
          nextStep: "retry",
        },
        {
          number: 23,
          repository: "OctopusGarage/fluent-frame",
          outcome: "manual-review",
          boundary: "product-decision",
          evidence: ["product choice required"],
          nextStep: "ask the product owner",
        },
      ],
    };

    expect(
      controller.recover(mixed, {
        account: "example-owner",
        cwd: "/repo/fluent-frame",
        now: 1000,
      }),
    ).toMatchObject({ disposition: "retry", openPullRequests: 2 });
  });
});
