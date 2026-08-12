import { describe, expect, it, vi } from "vitest";
import {
  createLoopRemoteBranchReconciler,
  type LoopRemoteBranchEvidenceWriter,
  type LoopRemoteBranchGitHub,
  type LoopRemoteBranchObservation,
  type LoopRemoteBranchTarget,
  planLoopRemoteBranchCleanup,
} from "../../src/core/loop/remote-branch-reconciliation.js";

const target: LoopRemoteBranchTarget = {
  repository: "OctopusGarage/tmux-claude-bot",
  projectId: "tmux-claude-bot",
  account: "example-owner",
  baseBranches: ["main", "dev"],
};

function observation(
  overrides: Partial<LoopRemoteBranchObservation> = {},
): LoopRemoteBranchObservation {
  return {
    repository: target.repository,
    branch: "loop/tmux-claude-bot/architecture/100-worker",
    sha: "abc123",
    protected: false,
    defaultBranch: "main",
    pullRequests: [
      {
        number: 22,
        state: "merged",
        headBranch: "loop/tmux-claude-bot/architecture/100-worker",
        headSha: "abc123",
        baseBranch: "dev",
      },
    ],
    ...overrides,
  };
}

describe("Loop remote branch cleanup policy", () => {
  it("accepts an exact terminal merged PR head", () => {
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: observation(),
        liveBranches: new Set(),
        closedReasons: new Map(),
      }),
    ).toEqual({ kind: "delete", pullRequestNumber: 22, reason: "merged-pull-request" });
  });

  it("refuses an observation from another repository", () => {
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: observation({ repository: "OctopusGarage/another-repository" }),
        liveBranches: new Set(),
        closedReasons: new Map(),
      }),
    ).toEqual({ kind: "skip", reason: "repository-mismatch" });
  });

  it.each([
    ["foreign prefix", { branch: "feature/user-owned" }, "outside-configured-prefix"],
    ["another project", { branch: "loop/another-project/100-worker" }, "outside-configured-prefix"],
    ["protected", { protected: true }, "protected-branch"],
    ["default", { branch: "main" }, "protected-base-branch"],
    ["configured base", { branch: "dev" }, "protected-base-branch"],
  ])("refuses %s branches", (_name, overrides, reason) => {
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: observation(overrides),
        liveBranches: new Set(),
        closedReasons: new Map(),
      }),
    ).toEqual({ kind: "skip", reason });
  });

  it("refuses open PRs, SHA drift, and live ownership", () => {
    const branch = observation().branch;
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: observation({
          pullRequests: [
            {
              number: 22,
              state: "open",
              headBranch: branch,
              headSha: "abc123",
              baseBranch: "dev",
            },
          ],
        }),
        liveBranches: new Set(),
        closedReasons: new Map(),
      }),
    ).toEqual({ kind: "skip", reason: "open-pull-request" });
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: observation({
          pullRequests: [
            {
              number: 22,
              state: "merged",
              headBranch: branch,
              headSha: "def456",
              baseBranch: "dev",
            },
          ],
        }),
        liveBranches: new Set(),
        closedReasons: new Map(),
      }),
    ).toEqual({ kind: "skip", reason: "pull-request-head-mismatch" });
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: observation(),
        liveBranches: new Set([branch]),
        closedReasons: new Map(),
      }),
    ).toEqual({ kind: "skip", reason: "live-work-order-owner" });
  });

  it("requires structured allowlisted evidence for a closed PR", () => {
    const closed = observation({
      pullRequests: [
        {
          number: 22,
          state: "closed",
          headBranch: "loop/tmux-claude-bot/architecture/100-worker",
          headSha: "abc123",
          baseBranch: "dev",
        },
      ],
    });
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: closed,
        liveBranches: new Set(),
        closedReasons: new Map(),
      }),
    ).toEqual({ kind: "skip", reason: "closed-reason-missing" });
    expect(
      planLoopRemoteBranchCleanup({
        target,
        observation: closed,
        liveBranches: new Set(),
        closedReasons: new Map([[`${target.repository}#22`, "duplicate"]]),
      }),
    ).toEqual({ kind: "delete", pullRequestNumber: 22, reason: "closed-duplicate" });
  });
});

function fakeEvidence(): LoopRemoteBranchEvidenceWriter & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    lookup: () => undefined,
    begin: () => {
      calls.push("intent");
      return { id: "evidence-1" };
    },
    finish: (_id, result) => {
      calls.push(`outcome:${result.status}`);
    },
  };
}

describe("Loop remote branch reconciliation", () => {
  it("persists intent, revalidates exact facts, deletes, and persists outcome", async () => {
    const current = observation();
    const calls: string[] = [];
    const github: LoopRemoteBranchGitHub = {
      discover: async () => ({ defaultBranch: "main", branches: [{ branch: current.branch }] }),
      observe: async () => {
        calls.push("observe");
        return current;
      },
      delete: async () => {
        calls.push("delete");
        return { ok: true, alreadyAbsent: false };
      },
    };
    const evidence = fakeEvidence();
    const reconciler = createLoopRemoteBranchReconciler({ github, evidence });

    const result = await reconciler.reconcile({
      targets: [target],
      liveBranches: new Set(),
      closedReasons: new Map(),
      now: 1000,
    });

    expect(result).toEqual({ scanned: 1, eligible: 1, deleted: 1, skipped: 0, failed: 0 });
    expect(calls).toEqual(["observe", "observe", "delete"]);
    expect(evidence.calls).toEqual(["intent", "outcome:succeeded"]);
  });

  it("fails closed when intent persistence fails", async () => {
    const github: LoopRemoteBranchGitHub = {
      discover: async () => ({
        defaultBranch: "main",
        branches: [{ branch: observation().branch }],
      }),
      observe: async () => observation(),
      delete: vi.fn(async () => ({ ok: true, alreadyAbsent: false })),
    };
    const reconciler = createLoopRemoteBranchReconciler({
      github,
      evidence: {
        lookup: () => undefined,
        begin: () => {
          throw new Error("disk unavailable");
        },
        finish: () => undefined,
      },
    });

    expect(
      await reconciler.reconcile({
        targets: [target],
        liveBranches: new Set(),
        closedReasons: new Map(),
        now: 1000,
      }),
    ).toEqual({ scanned: 1, eligible: 1, deleted: 0, skipped: 0, failed: 1 });
    expect(github.delete).not.toHaveBeenCalled();
  });

  it("refuses deletion when last-moment facts drift", async () => {
    const first = observation();
    const github: LoopRemoteBranchGitHub = {
      discover: async () => ({ defaultBranch: "main", branches: [{ branch: first.branch }] }),
      observe: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(observation({ sha: "def456" })),
      delete: vi.fn(async () => ({ ok: true, alreadyAbsent: false })),
    };
    const evidence = fakeEvidence();
    const reconciler = createLoopRemoteBranchReconciler({ github, evidence });

    expect(
      await reconciler.reconcile({
        targets: [target],
        liveBranches: new Set(),
        closedReasons: new Map(),
        now: 1000,
      }),
    ).toEqual({ scanned: 1, eligible: 1, deleted: 0, skipped: 0, failed: 1 });
    expect(github.delete).not.toHaveBeenCalled();
    expect(evidence.calls).toEqual(["intent", "outcome:failed"]);
  });

  it("settles durable failure evidence when GitHub deletion throws", async () => {
    const github: LoopRemoteBranchGitHub = {
      discover: async () => ({
        defaultBranch: "main",
        branches: [{ branch: observation().branch }],
      }),
      observe: async () => observation(),
      delete: async () => {
        throw new Error("network token=secret");
      },
    };
    const evidence = fakeEvidence();
    const reconciler = createLoopRemoteBranchReconciler({ github, evidence });

    expect(
      await reconciler.reconcile({
        targets: [target],
        liveBranches: new Set(),
        closedReasons: new Map(),
        now: 1000,
      }),
    ).toEqual({ scanned: 1, eligible: 1, deleted: 0, skipped: 0, failed: 1 });
    expect(evidence.calls).toEqual(["intent", "outcome:failed"]);
  });

  it("is restart-idempotent when the successfully deleted branch is absent", async () => {
    const github: LoopRemoteBranchGitHub = {
      discover: async () => ({ defaultBranch: "main", branches: [] }),
      observe: async () => observation(),
      delete: vi.fn(async () => ({ ok: true, alreadyAbsent: false })),
    };
    const reconciler = createLoopRemoteBranchReconciler({
      github,
      evidence: {
        lookup: () => "succeeded",
        begin: () => ({ id: "unused" }),
        finish: () => undefined,
      },
    });

    expect(
      await reconciler.reconcile({
        targets: [target],
        liveBranches: new Set(),
        closedReasons: new Map(),
        now: 1000,
      }),
    ).toEqual({ scanned: 0, eligible: 0, deleted: 0, skipped: 0, failed: 0 });
    expect(github.delete).not.toHaveBeenCalled();
  });

  it("does not repeat a cleanup whose successful evidence survived restart", async () => {
    const github: LoopRemoteBranchGitHub = {
      discover: async () => ({
        defaultBranch: "main",
        branches: [{ branch: observation().branch }],
      }),
      observe: async () => observation(),
      delete: vi.fn(async () => ({ ok: true, alreadyAbsent: false })),
    };
    const reconciler = createLoopRemoteBranchReconciler({
      github,
      evidence: {
        lookup: () => "succeeded",
        begin: () => ({ id: "unused" }),
        finish: () => undefined,
      },
    });

    expect(
      await reconciler.reconcile({
        targets: [target],
        liveBranches: new Set(),
        closedReasons: new Map(),
        now: 1000,
      }),
    ).toEqual({ scanned: 1, eligible: 1, deleted: 0, skipped: 1, failed: 0 });
    expect(github.delete).not.toHaveBeenCalled();
  });

  it("bounds discovery per repository", async () => {
    const github: LoopRemoteBranchGitHub = {
      discover: vi.fn(async () => ({ defaultBranch: "main", branches: [] })),
      observe: async () => null,
      delete: async () => ({ ok: true, alreadyAbsent: false }),
    };
    const reconciler = createLoopRemoteBranchReconciler({ github, evidence: fakeEvidence() });
    await reconciler.reconcile({
      targets: [target],
      liveBranches: new Set(),
      closedReasons: new Map(),
      now: 1000,
      limitPerRepository: 25,
    });
    expect(github.discover).toHaveBeenCalledWith(target, 25);
  });
});
