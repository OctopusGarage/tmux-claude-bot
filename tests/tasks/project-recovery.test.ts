import { describe, expect, it } from "vitest";
import {
  classifyHistoricalFailure,
  type HistoricalRecoveryInput,
  resolveConfiguredRecoveryTarget,
} from "../../src/core/tasks/project-recovery.js";

const base: HistoricalRecoveryInput = {
  taskId: "loop:alcove:architecture:1000",
  source: "loop-engineering",
  name: "alcove architecture",
  status: "failed",
  error: "supervisor-failed",
  summary: "Recovered loop supervisor run did not complete successfully.",
  attempt: 0,
};

describe("project recovery", () => {
  it("classifies missing project tooling as retryable", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        summary: "Preflight failed because .venv/bin/pytest is missing.",
      }),
    ).toMatchObject({ classification: "retryable", reason: expect.stringContaining("preflight") });
  });

  it("classifies invalid supervisor summaries as retryable", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        source: "autopilot-delegate",
        error: "invalid-summary",
        failureKind: "invalid-final-summary",
      }),
    ).toMatchObject({ classification: "retryable" });
    expect(
      classifyHistoricalFailure({
        ...base,
        error: "blocked",
        failureKind: "invalid-final-summary",
        summary:
          "Authoritative supervisor final summary reports incomplete recovery (status=blocked).",
      }),
    ).toMatchObject({ classification: "retryable" });
  });

  it("classifies missing architecture assessment scores as retryable automation contract failures", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        error: "blocked",
        summary:
          "Architecture assessment result did not include a numeric score; worker reported score:null and targetScore=90.",
        artifactText:
          "The assessment command emitted actionable findings but no numeric score, so the WorkOrder stopped for an assessment score contract repair.",
        attempt: 0,
      }),
    ).toMatchObject({
      classification: "retryable",
      reason: expect.stringContaining("assessment scoring contract"),
    });
  });

  it("classifies CI and merge decisions without dispatching them", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        summary: "GitHub build was cancelled because no runner was available.",
      }).classification,
    ).toBe("waiting-external");
    expect(
      classifyHistoricalFailure({
        ...base,
        summary: "PR is draft and mergeable=CONFLICTING.",
      }).classification,
    ).toBe("needs-owner-decision");
  });

  it("uses supervisor artifact evidence instead of a generic ledger summary", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        summary: "Recovered loop supervisor run did not complete successfully.",
        artifactText: "PR is blocked because mergeable=CONFLICTING and mergeStateStatus=DIRTY.",
      }).classification,
    ).toBe("needs-owner-decision");
  });

  it("resolves a configured project from ledger task identity", () => {
    const target = resolveConfiguredRecoveryTarget(
      {
        projects: [
          {
            id: "alcove",
            name: "Alcove",
            path: "/repo/alcove",
          },
        ],
        repositories: [],
        workspaces: [],
      },
      base,
      (path) => path,
    );

    expect(target).toMatchObject({
      kind: "project",
      id: "alcove",
      path: "/repo/alcove",
    });
  });

  it("refuses an ambiguous or unconfigured project", () => {
    expect(
      resolveConfiguredRecoveryTarget(
        { projects: [], repositories: [], workspaces: [] },
        base,
        (path) => path,
      ),
    ).toBeNull();
  });

  it("classifies superseded and exhausted records", () => {
    expect(
      classifyHistoricalFailure({ ...base, laterSuccess: true, attempt: 0 }).classification,
    ).toBe("superseded");
    expect(classifyHistoricalFailure({ ...base, attempt: 3 }).classification).toBe("dead-letter");
  });

  it("keeps supervisor lease and admission capacity failures retryable past the retry budget", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        error: "queued task could not acquire its supervisor lease",
        summary: "Recovery classification: needs-owner-decision",
        attempt: 3,
      }),
    ).toMatchObject({
      classification: "retryable",
      reason: expect.stringContaining("capacity"),
    });
    expect(
      classifyHistoricalFailure({
        ...base,
        summary:
          "Recovery dispatch deferred: automation admission deferred: interactive-agent-busy",
        attempt: 3,
      }),
    ).toMatchObject({
      classification: "retryable",
      reason: expect.stringContaining("capacity"),
    });
  });

  it("keeps assessment scoring contract failures retryable past the retry budget", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        summary: "Recovery blocked because the assessment result did not include a numeric score.",
        artifactText: "score:null with guarded architecture findings",
        attempt: 3,
      }),
    ).toMatchObject({
      classification: "retryable",
      reason: expect.stringContaining("assessment scoring contract"),
    });
  });

  it("keeps source worktree branch divergence retryable past the retry budget", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        error: "blocked",
        summary:
          "The source worktree dev is neither ancestor nor descendant of origin/dev; local branch is ahead 3 and behind 14.",
        artifactText:
          "Source evidence shows a branch divergence in the source worktree, not a project-owner decision.",
        attempt: 3,
      }),
    ).toMatchObject({
      classification: "retryable",
      reason: expect.stringContaining("source worktree branch state"),
    });
  });

  it("does not treat ordinary source worktree audit notes as branch-state failures", () => {
    expect(
      classifyHistoricalFailure({
        ...base,
        error: "blocked",
        summary:
          "Original source worktree stayed on dev and clean. PR checks failed because GitHub account payments failed or spending limit needs to be increased.",
        artifactText:
          "No source worktree mutation was performed; the remaining blocker is GitHub billing.",
        attempt: 0,
      }),
    ).toMatchObject({
      classification: "waiting-external",
      reason: expect.stringContaining("external service"),
    });
  });

  it("resolves repository and workspace targets", () => {
    expect(
      resolveConfiguredRecoveryTarget(
        {
          projects: [],
          repositories: [{ id: "geo-backend-all-prs", path: "/repo/geo-backend" }],
          workspaces: [{ id: "geo", name: "Geo", root: "/repo/geo" }],
        },
        { taskId: "loop:pr-review:geo-backend-all-prs:1", name: "repository review" },
        (path) => path,
      ),
    ).toMatchObject({ kind: "repository", id: "geo-backend-all-prs" });
    expect(
      resolveConfiguredRecoveryTarget(
        {
          projects: [],
          repositories: [],
          workspaces: [{ id: "geo", name: "Geo", root: "/repo/geo" }],
        },
        { taskId: "loop:workspace:geo:architecture:1", name: "geo workspace" },
        (path) => path,
      ),
    ).toMatchObject({ kind: "workspace", id: "geo" });
  });

  it("resolves active delegated recovery targets from explicit WorkOrder evidence", () => {
    expect(
      resolveConfiguredRecoveryTarget(
        {
          projects: [],
          repositories: [{ id: "net-auto-switch-all-prs", path: "/repo/net-auto-switch" }],
          workspaces: [],
        },
        {
          taskId: "autopilot:1786701483506-net-auto-switch-active-delegate",
          name: "net-auto-switch active delegated task",
          artifactText: "Historical scheduled task recovery.\nProject: net-auto-switch-all-prs\n",
        },
        (path) => path,
      ),
    ).toMatchObject({ kind: "repository", id: "net-auto-switch-all-prs" });
  });

  it("rejects equally specific configured targets", () => {
    expect(
      resolveConfiguredRecoveryTarget(
        {
          projects: [{ id: "geo-a", name: "Geo project", path: "/repo/project" }],
          repositories: [{ id: "geo-b", path: "/repo/repository" }],
          workspaces: [],
        },
        { taskId: "loop:geo-a:geo-b:architecture:1", name: "geo architecture" },
        (path) => path,
      ),
    ).toBeNull();
  });
});
