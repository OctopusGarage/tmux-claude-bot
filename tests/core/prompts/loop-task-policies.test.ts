import { describe, expect, it } from "vitest";
import type {
  LoopWorkOrder,
  LoopWorkOrderTask,
} from "../../../src/core/loop/work-order-contract.js";
import {
  buildLoopTaskPolicyLines,
  buildLoopWorkspacePolicyLines,
} from "../../../src/core/prompts/loop-task-policies.js";

function workOrder(overrides: Partial<LoopWorkOrder> = {}): LoopWorkOrder {
  return {
    id: "run-1",
    scheduledAt: 1,
    projectId: "repo",
    projectName: "Repo",
    projectPath: "/workspace/repo",
    agent: "codex",
    goal: "Improve safely.",
    maxRounds: 2,
    targetScore: 90,
    runner: { kind: "agent-supervised", requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "npm run assess" },
    execution: { agent: true },
    recovery: { agent: true, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: false },
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:run-1]",
    ...overrides,
  };
}

function linesFor(task: LoopWorkOrderTask, overrides: Partial<LoopWorkOrder> = {}): string[] {
  return buildLoopTaskPolicyLines(workOrder({ ...overrides, task }), "main");
}

function expectLine(lines: string[], text: string): void {
  expect(lines.some((line) => line.includes(text))).toBe(true);
}

describe("Loop task policy prompt lines", () => {
  it("defaults missing task metadata to architecture policy with conservative cleanup", () => {
    const lines = buildLoopTaskPolicyLines(workOrder(), "main");

    expectLine(lines, "Architecture target score is 90");
    expectLine(lines, "Cleanup policy is conservative");
  });

  it("lets task-specific cleanup policy override the WorkOrder cleanup policy", () => {
    const lines = linesFor(
      {
        kind: "bug-fix",
        maxRounds: 1,
        maxBugsPerRound: 2,
        requireRegressionTest: true,
        cleanupPolicy: "aggressive",
        prompt: "focus on queue correctness",
      },
      { cleanupPolicy: "conservative" },
    );

    expectLine(lines, "Bug finding and repair task.");
    expectLine(lines, "Run at most 1 focused bug-fix round(s)");
    expectLine(lines, "Cleanup policy is aggressive");
    expectLine(lines, "Add or update a focused regression test");
    expectLine(
      lines,
      "If touched code uses async tasks, cancellation, finally blocks, retries, queues, locks, streams",
    );
    expectLine(lines, "Additional bug-fix instruction: focus on queue correctness");
  });

  it("keeps coverage policy meaningful and respects disabled test categories", () => {
    const lines = linesFor({
      kind: "test-coverage",
      targetCoverage: 85,
      maxRounds: 3,
      requireMeaningfulTests: true,
      allowIntegrationTests: false,
      allowSmokeTests: false,
      allowE2ETests: false,
      allowAiEvalTests: false,
      cleanupPolicy: "balanced",
      prompt: "cover branch risk first",
    });

    expectLine(lines, "Target effective test coverage is at least 85%");
    expectLine(lines, "Do not add padding tests.");
    expectLine(lines, "Do not add integration tests for this task.");
    expectLine(lines, "Do not add smoke tests for this task.");
    expectLine(lines, "Do not add E2E tests for this task.");
    expectLine(lines, "Do not add AI eval tests for this task.");
    expectLine(lines, "Cleanup policy is balanced");
    expectLine(lines, "Additional test-coverage instruction: cover branch risk first");
  });

  it("renders security maintenance allowlists and bounded cleanup policy", () => {
    const lines = linesFor({
      kind: "security-maintenance",
      maxRounds: 2,
      actionThreshold: 7,
      criticalThreshold: 9,
      allowDependencyUpdates: true,
      allowConfigHardening: true,
      allowStaticAnalysisFixes: true,
      cleanupPolicy: "balanced",
      prompt: "start with GitHub security alerts",
    });

    expectLine(lines, "Security maintenance task.");
    expectLine(lines, "action threshold 7; critical threshold 9");
    expectLine(
      lines,
      "Dependency updates are allowed only when they address a confirmed security issue",
    );
    expectLine(lines, "Config hardening is allowed when it directly reduces a confirmed exposure");
    expectLine(
      lines,
      "Static analysis fixes are allowed when they correct a real security-sensitive behavior",
    );
    expectLine(lines, "Cleanup policy is balanced");
    expectLine(
      lines,
      "Additional security-maintenance instruction: start with GitHub security alerts",
    );
  });

  it("renders opportunity discovery report boundaries without granting implementation authority", () => {
    const lines = linesFor(
      {
        kind: "opportunity-discovery",
        maxRounds: 1,
        maxSuggestions: 3,
        minConfidence: "medium",
        categories: ["testing", "developer-experience"],
        cooldownDays: 14,
        requireEvidence: true,
        prompt: "prefer repeated manual workflows",
      },
      { opportunityReportPath: "/tmp/opportunities.json" },
    );

    expectLine(lines, "Opportunity discovery task.");
    expectLine(lines, "do not edit files, commit, push, create branches, create PRs");
    expectLine(lines, "Produce at most 3 suggestion(s)");
    expectLine(lines, "Minimum confidence is medium");
    expectLine(lines, "Allowed categories: testing, developer-experience");
    expectLine(lines, "Every suggestion must cite concrete evidence");
    expectLine(lines, "Write the opportunity report JSON to '/tmp/opportunities.json'");
    expectLine(
      lines,
      "Additional opportunity-discovery instruction: prefer repeated manual workflows",
    );
  });

  it("renders automation-governance repair limits and structured governance policy", () => {
    const lines = linesFor(
      {
        kind: "automation-governance-review",
        targetScore: 91,
        maxFindings: 4,
        allowRepairPr: true,
        requireAiEval: true,
        prompt: "check scheduler and ledger drift",
      },
      {
        governance: {
          scope: "bot-self-maintenance",
          targetScore: 91,
          maxFindings: 4,
          requireAiEval: true,
          repair: {
            allowPullRequest: true,
            autoMerge: false,
            minimumSeverity: "P1",
            maxPullRequests: 1,
          },
        },
      },
    );

    expectLine(lines, "Automation governance review task.");
    expectLine(lines, "Target governance score is at least 91");
    expectLine(
      lines,
      "Agent-backed AI eval may be used through the existing Claude Code / Codex control surface only",
    );
    expectLine(
      lines,
      "You may create a repair PR or update one repair PR only for a concrete P0/P1",
    );
    expectLine(lines, "Governance repair PRs must not be auto-merged");
    expectLine(lines, "Structured governance policy: scope=bot-self-maintenance");
    expectLine(
      lines,
      "Additional automation-governance-review instruction: check scheduler and ledger drift",
    );
  });

  it("renders repository PR review repair boundaries and merge method", () => {
    const noRepair = linesFor({
      kind: "repository-pull-request-review",
      repo: "OctopusGarage/repo",
      lookbackHours: 24,
      consecutivePasses: 2,
      autoMerge: false,
      mergeMethod: "squash",
      repair: { enabled: false, maxAttempts: 0 },
    });
    const repairAndMerge = linesFor({
      kind: "repository-pull-request-review",
      repo: "OctopusGarage/repo",
      lookbackHours: 24,
      consecutivePasses: 2,
      autoMerge: true,
      mergeMethod: "rebase",
      repair: { enabled: true, maxAttempts: 2, prompt: "repair CI-only failures" },
    });

    expectLine(noRepair, "Do not modify PR branches; report blockers only.");
    expectLine(
      noRepair,
      "For async, cancellation, finally, retry, queue, lock, stream, billing, or background-spawn changes",
    );
    expectLine(noRepair, "Do not merge automatically");
    expectLine(repairAndMerge, "at most 2 repair attempt(s)");
    expectLine(repairAndMerge, "Additional repair instruction: repair CI-only failures");
    expectLine(repairAndMerge, "merge the PR with GitHub CLI using --rebase");
  });

  it("renders workspace pull-request review across PR-enabled repositories only", () => {
    const lines = linesFor(
      {
        kind: "pull-request-review",
        lookbackHours: 48,
        consecutivePasses: 2,
        autoMerge: true,
        mergeMethod: "merge",
        prompt: "prioritize fresh loop branches",
      },
      {
        workspace: {
          root: "/workspace",
          repositories: [
            {
              id: "api",
              name: "API",
              path: "/workspace/api",
              role: "backend",
              agent: "codex",
              pullRequest: {
                enabled: true,
                base: "main",
                switchBack: "dev",
                autoMerge: false,
                mergeMethod: "squash",
              },
            },
            {
              id: "web",
              name: "Web",
              path: "/workspace/web",
              role: "frontend",
              agent: "codex",
              pullRequest: {
                enabled: false,
                base: "release",
                switchBack: "release",
                autoMerge: false,
                mergeMethod: "merge",
              },
            },
          ],
        },
      },
    );

    expectLine(lines, "Workspace pull request review and merge task.");
    expectLine(lines, "api(main->dev, autoMerge=false)");
    expect(lines.join("\n")).not.toContain("web(release->release");
    expectLine(lines, "merge the PR according to that repository's pullRequest policy");
    expectLine(
      lines,
      "For async, cancellation, finally, retry, queue, lock, stream, billing, or background-spawn changes",
    );
    expectLine(lines, "Additional review instruction: prioritize fresh loop branches");
  });

  it("describes workspace repository policy for source and isolated worktrees", () => {
    const lines = buildLoopWorkspacePolicyLines(
      workOrder({
        task: { kind: "workspace-architecture", prompt: "check API contracts" },
        workspace: {
          root: "/workspace",
          repositories: [
            {
              id: "api",
              name: "API",
              path: "/workspace/api",
              role: "backend",
              agent: "codex",
              pullRequest: {
                enabled: true,
                base: "main",
                switchBack: "dev",
                autoMerge: false,
                mergeMethod: "squash",
                githubAccount: "owner's-bot",
              },
            },
            {
              id: "web",
              name: "Web",
              path: "/state/loop-worktrees/repo/run-1/web",
              sourcePath: "/workspace/web",
              role: "frontend",
              agent: "codex",
              pullRequest: {
                enabled: true,
                base: "release",
                switchBack: "release",
                autoMerge: false,
                mergeMethod: "merge",
              },
            },
          ],
        },
      }),
    );

    expectLine(lines, "Treat Repo as one bounded workspace with 2 repositories.");
    expectLine(lines, "For api, use branch loop/api/architecture/run-1");
    expectLine(lines, "gh auth token --user 'owner'\\''s-bot'");
    expectLine(lines, "For web, use isolated worktree /state/loop-worktrees/repo/run-1/web");
    expectLine(lines, "keep original worktree /workspace/web clean on release");
  });

  it("captures active delegated task execution, review, coverage, eval, and PR inheritance", () => {
    const lines = linesFor(
      {
        kind: "active-delegated-task",
        sourceSession: "tmux_source",
        requirement: "finish the requested coverage slice",
        requireReview: true,
        requireTests: true,
        requireCoverageReview: true,
        allowAiEval: false,
      },
      {
        projectPath: "/state/loop-worktrees/repo/run-1",
        executionIsolation: {
          mode: "supervised-worker",
          expectedWorktree: "/state/loop-worktrees/repo/run-1",
          sourceWorktree: "/workspace/repo",
          worktreeIsolation: "isolated",
          contextReset: "compact",
          cleanup: {
            success: "release-worker",
            failure: "retain-for-ttl",
            retainFailureForHours: 72,
          },
        },
        commitPolicy: { enabled: true, perRound: false, branch: "loop/repo/run-1" },
        pullRequestPolicy: {
          enabled: true,
          base: "main",
          switchBack: "dev",
          autoMerge: true,
          mergeMethod: "merge",
        },
      },
    );

    expectLine(lines, "source context only");
    expectLine(lines, "perform an independent review pass");
    expectLine(lines, "Run the target project's relevant tests");
    expectLine(lines, "Review test coverage for the touched behavior");
    expectLine(lines, "Do not add or run AI eval work");
    expectLine(lines, "branch from main, use loop/repo/run-1");
    expectLine(lines, "allow auto-merge with --merge only after all gates pass");
    expectLine(lines, "the bot system owns source branch switch-back for dev");
  });

  it("captures active delegated task optional gates without inventing a project PR policy", () => {
    const lines = linesFor({
      kind: "active-delegated-task",
      sourceSession: "tmux_source",
      requirement: "answer the current user question",
      requireReview: false,
      requireTests: false,
      requireCoverageReview: false,
      allowAiEval: true,
    });

    expectLine(lines, "A final review pass is optional");
    expectLine(lines, "Tests are optional for this WorkOrder");
    expectLine(lines, "Coverage review is optional");
    expectLine(lines, "agent-backed or deterministic AI eval surface");
    expectLine(lines, "No project PR policy was matched");
  });
});
