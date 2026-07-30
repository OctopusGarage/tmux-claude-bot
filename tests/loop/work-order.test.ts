import { describe, expect, it } from "vitest";
import { type LoopProjectConfig, parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  buildActiveDelegatedTaskWorkOrder,
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
  buildLoopWorkOrder,
  buildLoopWorkspaceWorkOrder,
  buildRepositoryPullRequestReviewWorkOrder,
  buildWorkspaceArchitectureWorkOrder,
  finalMarkerForWorkOrder,
  parseSupervisorFinalSummary,
} from "../../src/core/loop/work-order.js";
import type { OpportunityCategory } from "../../src/core/opportunities/types.js";

const config = parseLoopConfigYaml(`
skills:
  approved:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      ref: 082131022ca026f353ab74d9a6e1dcc11adbd954
      checksum: sha256:abc
      platforms: [codex]
      tags: [architecture]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
projects:
  - id: datavibe
    name: Datavibe
    path: /repo/datavibe
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 7200000
      maxTurns: 20
    goal: Improve architecture.
    maxRounds: 3
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, dependency-upgrade, broad-rewrite]
`);

function firstProject() {
  const project = config.projects[0];
  if (project === undefined) throw new Error("expected test config project");
  return project;
}

describe("loop supervisor work order", () => {
  it("builds a bounded work order from project config", () => {
    const project = firstProject();
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: Date.parse("2026-07-16T05:30:00Z"),
      runId: "1752643800000-datavibe",
    });

    expect(workOrder).toMatchObject({
      id: "1752643800000-datavibe",
      projectId: "datavibe",
      projectPath: "/repo/datavibe",
      agent: "codex",
      maxRounds: 3,
      targetScore: 90,
      runner: {
        kind: "agent-supervised",
        timeoutMs: 7200000,
        maxTurns: 20,
        requireConfirmation: false,
      },
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1752643800000-datavibe]",
    });
    expect(workOrder.finalSummaryPath).toContain(
      "loop-runs/datavibe/1752643800000-datavibe/supervisor-final-summary.json",
    );
    expect(workOrder.skills.approved[0]?.id).toBe("improve-codebase-architecture");
  });

  it("derives a run-specific branch from a configured commit branch", () => {
    const project = {
      ...firstProject(),
      commit: {
        enabled: true,
        perRound: true,
        branch: "loop/datavibe/architecture",
      },
    };

    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe",
    });

    expect(workOrder.commitPolicy.branch).toBe("loop/datavibe/architecture/1752643800000-datavibe");
  });

  it("renders a prompt with policy, commands, and the final marker", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: firstProject(),
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe",
      projectSessionPrefix: "tmux_proj_",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.notificationSession).toBe("tmux_proj_-repo-datavibe");
    expect(prompt).toContain("You are the Loop Supervisor for tmux-claude-bot.");
    expect(prompt).toContain("Do not call model-provider APIs.");
    expect(prompt).toContain('send <project> "<task>"');
    expect(prompt).toContain("dashboard --json");
    expect(prompt).toContain("open '/repo/datavibe' --agent codex");
    expect(prompt).toContain("git status --short must be clean");
    expect(prompt).toContain("git fetch origin main");
    expect(prompt).toContain("git switch main");
    expect(prompt).toContain("git pull --ff-only origin main");
    expect(prompt).toContain("do not optimize stale code");
    expect(prompt).toContain("supervisor-final-summary.json");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("dashboard --json shows the target project running");
    expect(prompt).toContain(
      "control <project> compact --yes before each delegated optimization round.",
    );
    expect(prompt).toContain(
      'status must be exactly one of: "completed", "blocked", "failed", "timeout", "cancelled"',
    );
    expect(prompt).toContain('Use "completed" for successful no-op runs');
    expect(prompt).toContain('finalVerification must be one string only: "passed"');
    expect(prompt).not.toContain("tcb status");
    expect(prompt).toContain(finalMarkerForWorkOrder("1752643800000-datavibe"));
  });

  it("renders an active delegated task prompt with review, coverage, and eval gates", () => {
    const workOrder = buildActiveDelegatedTaskWorkOrder({
      session: "tmux_proj_repo",
      projectId: "repo",
      projectName: "Repo",
      projectPath: "/repo/app",
      agent: "codex",
      requirement: "Implement the agreed settings flow.",
      scheduledAt: 1752643800000,
      runId: "1752643800000-repo-active-delegate",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "active-delegated-task",
      sourceSession: "tmux_proj_repo",
      requirement: "Implement the agreed settings flow.",
      requireReview: true,
      requireTests: true,
      requireCoverageReview: true,
      allowAiEval: true,
    });
    expect(workOrder.commitPolicy.enabled).toBe(false);
    expect(workOrder.pullRequestPolicy?.enabled).toBe(false);
    expect(prompt).toContain("Active delegated task.");
    expect(prompt).toContain("not a cron maintenance run");
    expect(prompt).toContain("Requirement: Implement the agreed settings flow.");
    expect(prompt).toContain("Drive the target project agent until the requested behavior");
    expect(prompt).toContain("perform an independent review pass");
    expect(prompt).toContain("Run the target project's relevant tests");
    expect(prompt).toContain("Review test coverage for the touched behavior");
    expect(prompt).toContain("agent-backed or deterministic AI eval surface");
    expect(prompt).toContain("preserve the user's active branch context");
    expect(prompt).toContain("must preserve the user's current branch by default");
    expect(prompt).not.toContain("git fetch origin main");
  });

  it("inherits project PR policy for active delegated tasks when a loop project matches", () => {
    const projectPolicy: LoopProjectConfig = {
      ...firstProject(),
      commit: {
        enabled: true,
        perRound: true,
        branch: "loop/datavibe/architecture",
      },
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: true,
        githubAccount: "Kingson4Wu",
      },
      recovery: {
        agent: true,
        dirtyWorktree: true,
        maxAttempts: 2,
      },
      allowedActions: ["tests", "docs", "small-refactor", "dependency-upgrade"],
      blockedActions: ["direct-model-api", "broad-rewrite"],
    };
    const workOrder = buildActiveDelegatedTaskWorkOrder({
      session: "tmux_proj_datavibe",
      projectId: "datavibe",
      projectName: "Datavibe",
      projectPath: "/repo/datavibe",
      agent: "codex",
      requirement: "Implement the accepted opportunity.",
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe-active-delegate",
      projectPolicy,
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.commitPolicy).toMatchObject({
      enabled: true,
      perRound: false,
      branch: "loop/datavibe/active-delegate/1752643800000-datavibe-active-delegate",
    });
    expect(workOrder.pullRequestPolicy).toMatchObject({
      enabled: true,
      base: "dev",
      switchBack: "dev",
      autoMerge: true,
      githubAccount: "Kingson4Wu",
    });
    expect(workOrder.recovery).toMatchObject({
      agent: true,
      dirtyWorktree: true,
      maxAttempts: 2,
    });
    expect(workOrder.allowedActions).toContain("dependency-upgrade");
    expect(prompt).toContain("git fetch origin dev");
    expect(prompt).toContain("git switch dev");
    expect(prompt).toContain("git pull --ff-only origin dev");
    expect(prompt).toContain("inherits the target project's PR policy");
    expect(prompt).toContain(
      "loop/datavibe/active-delegate/1752643800000-datavibe-active-delegate",
    );
    expect(prompt).toContain("open or update one PR against dev");
    expect(prompt).toContain("allow auto-merge only after all gates pass");
    expect(prompt).toContain("switch the local worktree back to dev");
    expect(prompt).toContain("GH_TOKEN=\"$(gh auth token --user 'Kingson4Wu')\"");
    expect(prompt).not.toContain("must preserve the user's current branch by default");
  });

  it("renders a bug-fix prompt that separates real bug repair from architecture work", () => {
    const project = {
      ...firstProject(),
      bugFix: {
        enabled: true,
        schedule: "45 10 * * *",
        branch: "loop/datavibe/bug-fix",
        maxRounds: 4,
        maxBugsPerRound: 1,
        requireRegressionTest: true,
        prompt: "Focus on scheduler, gate, and state consistency bugs.",
      },
      commit: {
        enabled: true,
        perRound: false,
        branch: "loop/datavibe/architecture",
      },
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: false,
      },
    };
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe-bug-fix",
      jobKind: "bug-fix",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "bug-fix",
      maxRounds: 4,
      maxBugsPerRound: 1,
      requireRegressionTest: true,
    });
    expect(workOrder.maxRounds).toBe(4);
    expect(workOrder.commitPolicy.branch).toBe(
      "loop/datavibe/bug-fix/1752643800000-datavibe-bug-fix",
    );
    expect(prompt).toContain("Bug finding and repair task.");
    expect(prompt).toContain("Search for real bugs only");
    expect(prompt).toContain("Audit through concrete risk lenses");
    expect(prompt).toContain("money, quota, billing, permissions");
    expect(prompt).toContain("Do not nitpick");
    expect(prompt).toContain("Do not add product features");
    expect(prompt).toContain("Separate candidate bugs from confirmed bugs");
    expect(prompt).toContain("entry point or trigger, affected path, expected behavior");
    expect(prompt).toContain("Before editing, prove the issue is real");
    expect(prompt).toContain("inspect that boundary before confirming the bug");
    expect(prompt).toContain("perform an independent verification pass");
    expect(prompt).toContain("deferred candidate or skipped candidate");
    expect(prompt).toContain("Add or update a focused regression test");
    expect(prompt).toContain("independently re-check the same evidence chain");
    expect(prompt).toContain("checked areas, skipped areas, deferred candidates");
    expect(prompt).toContain("partial coverage must not be presented as proof");
    expect(prompt).toContain("Stop when a round finds no confirmed real bugs");
    expect(prompt).toContain(
      "control <project> compact --yes before each delegated bug-fix round.",
    );
    expect(prompt).toContain("Focus on scheduler, gate, and state consistency bugs.");
    expect(prompt).toContain("loop/datavibe/bug-fix/1752643800000-datavibe-bug-fix");
    expect(prompt).not.toContain("Architecture target score");
  });

  it("renders an opportunity-discovery prompt that proposes work without editing", () => {
    const project = {
      ...firstProject(),
      opportunityDiscovery: {
        enabled: true,
        schedule: "15 9 * * *",
        scheduleJitterMinutes: 5,
        notificationChannel: "both" as const,
        maxSuggestions: 2,
        minConfidence: "medium" as const,
        categories: ["product-feature", "developer-experience"] satisfies OpportunityCategory[],
        cooldownDays: 14,
        requireEvidence: true,
        prompt: "Prefer ideas that reduce owner coordination.",
      },
      commit: {
        enabled: true,
        perRound: true,
        branch: "loop/datavibe/architecture",
      },
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: true,
      },
      eval: {
        command: "npm run eval",
        minScore: 95,
      },
    };
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe-opportunity-discovery",
      jobKind: "opportunity-discovery",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "opportunity-discovery",
      maxSuggestions: 2,
      minConfidence: "medium",
      categories: ["product-feature", "developer-experience"],
      cooldownDays: 14,
      requireEvidence: true,
      notificationChannel: "both",
    });
    expect(workOrder.opportunityReportPath).toContain(
      "loop-runs/datavibe/1752643800000-datavibe-opportunity-discovery/opportunities.json",
    );
    expect(workOrder.commitPolicy.enabled).toBe(false);
    expect(workOrder.pullRequestPolicy?.enabled).toBe(false);
    expect(workOrder.pullRequestPolicy).toMatchObject({
      base: "dev",
      switchBack: "dev",
      autoMerge: false,
    });
    expect(workOrder.assessment).toEqual({ command: "true" });
    expect(workOrder.eval).toBeUndefined();
    expect(prompt).toContain("Opportunity discovery task.");
    expect(prompt).toContain("git fetch origin dev");
    expect(prompt).toContain("git switch dev");
    expect(prompt).toContain("do not edit files, commit, push, create branches");
    expect(prompt).toContain("Produce at most 2 suggestion(s)");
    expect(prompt).toContain("Minimum confidence is medium");
    expect(prompt).toContain("Allowed categories: product-feature, developer-experience");
    expect(prompt).toContain("Every suggestion must cite concrete evidence");
    expect(prompt).toContain("Write the opportunity report JSON");
    expect(prompt).toContain("delegateRequirement");
    expect(prompt).toContain("must not create a branch, commit, PR, or code change");
  });

  it("renders a test-coverage prompt that rejects meaningless coverage padding", () => {
    const project = {
      ...firstProject(),
      testCoverage: {
        enabled: true,
        schedule: "20 14 * * *",
        branch: "loop/datavibe/test-coverage",
        targetCoverage: 80,
        maxRounds: 5,
        requireMeaningfulTests: true,
        allowIntegrationTests: true,
        allowSmokeTests: true,
        allowE2ETests: false,
        allowAiEvalTests: false,
        prompt: "Prioritize billing, auth, and queue workflows.",
      },
      commit: {
        enabled: true,
        perRound: false,
        branch: "loop/datavibe/architecture",
      },
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: false,
      },
    };
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe-test-coverage",
      jobKind: "test-coverage",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "test-coverage",
      targetCoverage: 80,
      maxRounds: 5,
      requireMeaningfulTests: true,
      allowIntegrationTests: true,
      allowSmokeTests: true,
      allowE2ETests: false,
      allowAiEvalTests: false,
    });
    expect(workOrder.maxRounds).toBe(5);
    expect(workOrder.commitPolicy.branch).toBe(
      "loop/datavibe/test-coverage/1752643800000-datavibe-test-coverage",
    );
    expect(prompt).toContain("Test coverage improvement task.");
    expect(prompt).toContain("Target effective test coverage is at least 80%");
    expect(prompt).toContain("current test stack, coverage command/report");
    expect(prompt).toContain("Add tests only when they assert real behavior");
    expect(prompt).toContain("Do not add import-only tests");
    expect(prompt).toContain("snapshot padding");
    expect(prompt).toContain("unit tests");
    expect(prompt).toContain("Integration tests are allowed");
    expect(prompt).toContain("Smoke tests are allowed");
    expect(prompt).toContain("Do not add E2E tests");
    expect(prompt).toContain("Do not add AI eval tests");
    expect(prompt).toContain("smallest necessary refactor");
    expect(prompt).toContain("If you discover a real bug");
    expect(prompt).toContain("no reliable unified coverage command");
    expect(prompt).toContain("compact --yes before each delegated test-coverage round");
    expect(prompt).toContain("Prioritize billing, auth, and queue workflows.");
  });

  it("renders a security-maintenance prompt for verified security fixes", () => {
    const project = {
      ...firstProject(),
      securityMaintenance: {
        enabled: true,
        schedule: "10 16 * * *",
        branch: "loop/datavibe/security-maintenance",
        maxRounds: 3,
        allowDependencyUpdates: true,
        allowConfigHardening: true,
        allowStaticAnalysisFixes: true,
        prompt: "Prioritize reachable auth, webhook, and supply-chain findings.",
      },
      commit: {
        enabled: true,
        perRound: false,
        branch: "loop/datavibe/architecture",
      },
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: false,
      },
    };
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe-security-maintenance",
      jobKind: "security-maintenance",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "security-maintenance",
      maxRounds: 3,
      allowDependencyUpdates: true,
      allowConfigHardening: true,
      allowStaticAnalysisFixes: true,
    });
    expect(workOrder.maxRounds).toBe(3);
    expect(workOrder.allowedActions).toContain("dependency-upgrade");
    expect(workOrder.blockedActions).not.toContain("dependency-upgrade");
    expect(workOrder.blockedActions).toContain("direct-model-api");
    expect(workOrder.commitPolicy.branch).toBe(
      "loop/datavibe/security-maintenance/1752643800000-datavibe-security-maintenance",
    );
    expect(prompt).toContain("Security maintenance task.");
    expect(prompt).toContain("not only dependency advisories");
    expect(prompt).toContain("GitHub security findings");
    expect(prompt).toContain("secret or token exposure");
    expect(prompt).toContain("prove the issue is real or plausibly reachable");
    expect(prompt).toContain("Dependency updates are allowed only when");
    expect(prompt).toContain("PR content must clearly separate");
    expect(prompt).toContain("compact --yes before each delegated security-maintenance round");
    expect(prompt).toContain("Prioritize reachable auth, webhook, and supply-chain findings.");
    expect(prompt).not.toContain("Architecture target score");
  });

  it("renders a harness-auto prompt that orchestrates health subtasks", () => {
    const project = {
      ...firstProject(),
      harnessAuto: {
        enabled: true,
        schedule: "50 16 * * *",
        scheduleJitterMinutes: 13,
        branch: "loop/datavibe/harness-auto",
        maxRounds: 4,
        strategy: "risk-first" as const,
        tasks: [
          { kind: "bug-fix" as const, enabled: true, weight: 50 },
          { kind: "security-maintenance" as const, enabled: true, weight: 30 },
          { kind: "test-coverage" as const, enabled: true, weight: 15 },
          { kind: "architecture" as const, enabled: true, weight: 5 },
        ],
        stopWhen: { healthScoreAtLeast: 96, noConfirmedIssues: true },
        prompt: "Prioritize production reliability and security.",
      },
      bugFix: {
        enabled: true,
        schedule: "45 10 * * *",
        maxRounds: 2,
        maxBugsPerRound: 1,
        requireRegressionTest: true,
      },
      testCoverage: {
        enabled: true,
        schedule: "20 14 * * *",
        targetCoverage: 82,
        maxRounds: 3,
        requireMeaningfulTests: true,
        allowIntegrationTests: true,
        allowSmokeTests: true,
        allowE2ETests: false,
        allowAiEvalTests: false,
      },
      securityMaintenance: {
        enabled: true,
        schedule: "10 16 * * *",
        maxRounds: 2,
        allowDependencyUpdates: true,
        allowConfigHardening: true,
        allowStaticAnalysisFixes: true,
      },
      commit: {
        enabled: true,
        perRound: false,
        branch: "loop/datavibe/architecture",
      },
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: false,
      },
    };
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe-harness-auto",
      jobKind: "harness-auto",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "harness-auto",
      maxRounds: 4,
      strategy: "risk-first",
      stopWhen: { healthScoreAtLeast: 96, noConfirmedIssues: true },
    });
    expect(workOrder.maxRounds).toBe(4);
    expect(workOrder.targetScore).toBe(96);
    expect(workOrder.allowedActions).toContain("dependency-upgrade");
    expect(workOrder.commitPolicy.branch).toBe(
      "loop/datavibe/harness-auto/1752643800000-datavibe-harness-auto",
    );
    expect(prompt).toContain("Harness-auto health orchestration task.");
    expect(prompt).toContain("Strategy is risk-first");
    expect(prompt).toContain("Enabled subtasks: bug-fix(weight=50)");
    expect(prompt).toContain("security-maintenance(weight=30)");
    expect(prompt).toContain("test-coverage(weight=15)");
    expect(prompt).toContain("architecture(weight=5)");
    expect(prompt).toContain("Do not run all subtasks mechanically");
    expect(prompt).toContain("one run id and one PR branch/PR per repository");
    expect(prompt).toContain("Harness subtask policy: bug-fix.");
    expect(prompt).toContain("Bug finding and repair task.");
    expect(prompt).toContain("Harness subtask policy: security-maintenance.");
    expect(prompt).toContain("Security maintenance task.");
    expect(prompt).toContain("Harness subtask policy: test-coverage.");
    expect(prompt).toContain("Test coverage improvement task.");
    expect(prompt).toContain("Harness subtask policy: architecture.");
    expect(prompt).toContain("Architecture target score is 90");
    expect(prompt).toContain("compact --yes before each delegated harness-auto round");
    expect(prompt).toContain("Prioritize production reliability and security.");
  });

  it("renders a pull request review prompt with two-pass merge guidance", () => {
    const project = {
      ...firstProject(),
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: true,
        githubAccount: "miao2016",
      },
      pullRequestReview: {
        enabled: true,
        schedule: "30 9 * * *",
        lookbackHours: 36,
        consecutivePasses: 2,
        autoMerge: true,
        prompt: "Review yesterday's loop PRs. Focus on introduced bugs, not nitpicks.",
      },
    };
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe-pr-review",
      jobKind: "pull-request-review",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({ kind: "pull-request-review" });
    expect(prompt).toContain("Pull request review and merge task.");
    expect(prompt).toContain("Run two independent review passes");
    expect(prompt).toContain("Do not nitpick");
    expect(prompt).toContain("mergeability");
    expect(prompt).toContain("CI/status checks");
    expect(prompt).toContain("gh auth token --user 'miao2016'");
    expect(prompt).toContain("git switch dev");
    expect(prompt).toContain("git pull --ff-only origin dev");
  });

  it("renders a repository-wide pull request review prompt for all open PRs", () => {
    const reviewConfig = parseLoopConfigYaml(`
projects:
  - id: placeholder
    name: Placeholder
    path: /repo/placeholder
    agent: codex
    goal: Keep placeholder architecture healthy.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
prReview:
  repositories:
    - id: tmux-claude-bot
      name: tmux-claude-bot
      path: /repo/tmux-claude-bot
      repo: OctopusGarage/tmux-claude-bot
      agent: codex
      schedule: "0 2 * * *"
      switchBack: dev
      githubAccount: Kingson4Wu
      lookbackHours: 72
      consecutivePasses: 2
      autoMerge: true
      repair:
        enabled: true
        maxAttempts: 1
        prompt: Only repair small deterministic check failures.
      prompt: Review all open PRs. Focus on introduced bugs, CI, and mergeability.
`);
    const repository = reviewConfig.prReview.repositories[0];
    if (repository === undefined) throw new Error("expected repository review config");

    const workOrder = buildRepositoryPullRequestReviewWorkOrder({
      config: reviewConfig,
      repository,
      scheduledAt: 1752643800000,
      runId: "1752643800000-tmux-claude-bot-repo-pr-review",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "repository-pull-request-review",
      repo: "OctopusGarage/tmux-claude-bot",
      repair: {
        enabled: true,
        maxAttempts: 1,
        prompt: "Only repair small deterministic check failures.",
      },
    });
    expect(workOrder.task).not.toHaveProperty("base");
    expect(workOrder.pullRequestPolicy).toMatchObject({ base: "dev", switchBack: "dev" });
    expect(prompt).toContain("Repository pull request review and merge task.");
    expect(prompt).toContain("Review every open pull request in OctopusGarage/tmux-claude-bot");
    expect(prompt).toContain("all base branches");
    expect(prompt).toContain(
      "gh pr list --repo OctopusGarage/tmux-claude-bot --state open --limit 100",
    );
    expect(prompt).not.toContain("--base dev --limit 100");
    expect(prompt).toContain("open PR count and each in-scope PR number/base/head/decision");
    expect(prompt).toContain('final status must be "blocked" or "failed", not "completed"');
    expect(prompt).toContain("do not ignore older open PRs");
    expect(prompt).toContain("Run two independent review passes");
    expect(prompt).toContain("required reviews are missing");
    expect(prompt).toContain("state=MERGED");
    expect(prompt).toContain("stop waiting on mergeability");
    expect(prompt).toContain("PR's original head branch");
    expect(prompt).toContain("same-repository branches");
    expect(prompt).toContain("Do not modify external fork PRs");
    expect(prompt).toContain("same-repository PR is conflicting");
    expect(prompt).toContain("same-repository PR branch is behind the base branch");
    expect(prompt).toContain("gh pr update-branch");
    expect(prompt).toContain(
      "bounded repair may commit only on an eligible PR's existing same-repository head branch",
    );
    expect(prompt).toContain("push to the PR head branch");
    expect(prompt).toContain("review passes are repeated on the updated PR");
    expect(prompt).toContain("Only repair small deterministic check failures.");
    expect(prompt).toContain("gh auth token --user 'Kingson4Wu'");
    expect(prompt).toContain("git switch dev");
    expect(prompt).toContain("do not call tcb open for the synthetic *-all-prs id");
    expect(prompt).not.toContain("open tmux-claude-bot --agent codex");
    expect(prompt).not.toContain("open tmux-claude-bot-all-prs --agent codex");
    expect(prompt).not.toContain("loop-created PRs");
    expect(prompt).not.toContain("must not create a new PR branch or commit code changes");
  });

  it("renders a workspace architecture prompt for coordinated multi-repository work", () => {
    const workspaceConfig = parseLoopConfigYaml(`
projects:
  - id: placeholder
    name: Placeholder
    path: /repo/placeholder
    agent: codex
    goal: Keep placeholder architecture healthy.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
          githubAccount: miao2016
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
    architecture:
      enabled: true
      schedule: "10 11 * * *"
      goal: Improve frontend/backend architecture together.
      maxRounds: 3
      targetScore: 95
      prompt: Focus on API contracts and shared data semantics.
`);
    const workspace = workspaceConfig.workspaces[0];
    if (workspace === undefined) throw new Error("expected workspace config");

    const workOrder = buildWorkspaceArchitectureWorkOrder({
      config: workspaceConfig,
      workspace,
      scheduledAt: 1752643800000,
      runId: "1752643800000-geo-workspace",
    });
    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder).toMatchObject({
      task: { kind: "workspace-architecture" },
      projectId: "geo",
      projectPath: "/repo/realestate",
      maxRounds: 3,
      targetScore: 95,
      workspace: {
        repositories: [
          {
            id: "geo-backend",
            role: "backend",
            path: "/repo/realestate/geo-backend",
            agent: "codex",
          },
          {
            id: "geo-frontend",
            role: "frontend",
            path: "/repo/realestate/geo-frontend",
            agent: "codex",
          },
        ],
      },
    });
    expect(prompt).toContain("Workspace architecture task.");
    expect(prompt).toContain("Treat Geo Workspace as one bounded workspace with 2 repositories.");
    expect(prompt).toContain("cross-repository evaluation reaches or exceeds it");
    expect(prompt).toContain("contracts between repositories");
    expect(prompt).toContain("API routes, schemas, generated clients, shared DTOs");
    expect(prompt).toContain("Do not force every repository to change.");
    expect(prompt).toContain("update all affected repositories in the same round");
    expect(prompt).toContain("Each repository keeps its own git branch and pull request.");
    expect(prompt).toContain("Use one shared run id");
    expect(prompt).toContain(
      "For geo-backend, use branch loop/geo-backend/architecture/1752643800000-geo-workspace",
    );
    expect(prompt).toContain("open the PR against main");
    expect(prompt).toContain("gh auth token --user 'miao2016'");
    expect(prompt).toContain("do not rely on the global gh active account");
    expect(prompt).toContain(
      "For geo-frontend, use branch loop/geo-frontend/architecture/1752643800000-geo-workspace",
    );
    expect(prompt).toContain("use the repository's normal GitHub CLI identity");
    expect(prompt).toContain("cd '/repo/realestate/geo-backend' && git status --short");
    expect(prompt).toContain("cd '/repo/realestate/geo-frontend' && git status --short");
    expect(prompt).toContain("open geo-backend --agent codex");
    expect(prompt).toContain("open geo-frontend --agent codex");
    expect(prompt).toContain("Focus on API contracts and shared data semantics.");
  });

  it("renders a workspace bug-fix prompt for coordinated multi-repository repair", () => {
    const workspaceConfig = parseLoopConfigYaml(`
projects:
  - id: placeholder
    name: Placeholder
    path: /repo/placeholder
    agent: codex
    goal: Keep placeholder architecture healthy.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
    architecture:
      enabled: false
      goal: Improve frontend/backend architecture together.
    bugFix:
      enabled: true
      schedule: "20 11 * * *"
      maxRounds: 5
      maxBugsPerRound: 1
      prompt: Focus on backend/frontend contract bugs.
`);
    const workspace = workspaceConfig.workspaces[0];
    if (workspace === undefined) throw new Error("expected workspace config");

    const workOrder = buildLoopWorkspaceWorkOrder({
      config: workspaceConfig,
      workspace,
      scheduledAt: 1752643800000,
      runId: "1752643800000-geo-workspace-bug-fix",
      jobKind: "bug-fix",
    });
    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder).toMatchObject({
      task: { kind: "bug-fix", maxRounds: 5, maxBugsPerRound: 1 },
      projectId: "geo",
      projectPath: "/repo/realestate",
      maxRounds: 5,
      targetScore: 100,
    });
    expect(prompt).toContain("Workspace multi-repository task.");
    expect(prompt).toContain("Bug finding and repair task.");
    expect(prompt).toContain("Do not force every repository to change.");
    expect(prompt).toContain("contracts between repositories");
    expect(prompt).toContain(
      "For geo-backend, use branch loop/geo-backend/bug-fix/1752643800000-geo-workspace-bug-fix",
    );
    expect(prompt).toContain(
      "For geo-frontend, use branch loop/geo-frontend/bug-fix/1752643800000-geo-workspace-bug-fix",
    );
    expect(prompt).toContain("open geo-backend --agent codex");
    expect(prompt).toContain("open geo-frontend --agent codex");
    expect(prompt).toContain(
      "control <project> compact --yes before each delegated bug-fix round.",
    );
    expect(prompt).toContain("Focus on backend/frontend contract bugs.");
    expect(prompt).not.toContain("Architecture target score");
  });

  it("renders a workspace harness-auto prompt for coordinated health improvement", () => {
    const workspaceConfig = parseLoopConfigYaml(`
projects:
  - id: placeholder
    name: Placeholder
    path: /repo/placeholder
    agent: codex
    goal: Keep placeholder architecture healthy.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
    architecture:
      enabled: false
      goal: Improve frontend/backend architecture together.
      targetScore: 95
    harnessAuto:
      enabled: true
      schedule: "50 16 * * *"
      maxRounds: 4
      strategy: health-first
      stopWhen:
        healthScoreAtLeast: 96
        noConfirmedIssues: true
      prompt: Prioritize cross-repository health.
`);
    const workspace = workspaceConfig.workspaces[0];
    if (workspace === undefined) throw new Error("expected workspace config");

    const workOrder = buildLoopWorkspaceWorkOrder({
      config: workspaceConfig,
      workspace,
      scheduledAt: 1752643800000,
      runId: "1752643800000-geo-workspace-harness-auto",
      jobKind: "harness-auto",
    });
    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "harness-auto",
      maxRounds: 4,
      stopWhen: { healthScoreAtLeast: 96, noConfirmedIssues: true },
    });
    expect(workOrder.projectPath).toBe("/repo/realestate");
    expect(workOrder.targetScore).toBe(96);
    expect(prompt).toContain("Workspace multi-repository task.");
    expect(prompt).toContain("Harness-auto health orchestration task.");
    expect(prompt).toContain(
      "For geo-backend, use branch loop/geo-backend/harness-auto/1752643800000-geo-workspace-harness-auto",
    );
    expect(prompt).toContain(
      "For geo-frontend, use branch loop/geo-frontend/harness-auto/1752643800000-geo-workspace-harness-auto",
    );
    expect(prompt).toContain("one run id and one PR branch/PR per repository");
    expect(prompt).toContain("Harness subtask policy: architecture.");
    expect(prompt).toContain("cross-repository evaluation reaches or exceeds it");
    expect(prompt).toContain("compact --yes before each delegated harness-auto round");
    expect(prompt).toContain("Prioritize cross-repository health.");
  });

  it("renders a workspace pull-request-review prompt for coordinated PR review", () => {
    const workspaceConfig = parseLoopConfigYaml(`
projects:
  - id: placeholder
    name: Placeholder
    path: /repo/placeholder
    agent: codex
    goal: Keep placeholder architecture healthy.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
          autoMerge: true
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
        pullRequest:
          enabled: true
          base: dev
          switchBack: dev
          autoMerge: false
    architecture:
      enabled: false
      goal: Improve frontend/backend architecture together.
    pullRequestReview:
      enabled: true
      schedule: "5 17 * * *"
      lookbackHours: 48
      consecutivePasses: 2
      autoMerge: true
`);
    const workspace = workspaceConfig.workspaces[0];
    if (workspace === undefined) throw new Error("expected workspace config");

    const workOrder = buildLoopWorkspaceWorkOrder({
      config: workspaceConfig,
      workspace,
      scheduledAt: 1752643800000,
      runId: "1752643800000-geo-workspace-pr-review",
      jobKind: "pull-request-review",
    });
    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "pull-request-review",
      lookbackHours: 48,
      autoMerge: true,
    });
    expect(workOrder.maxRounds).toBe(1);
    expect(prompt).toContain("Workspace pull request review and merge task.");
    expect(prompt).toContain("geo-backend(main->main, autoMerge=true)");
    expect(prompt).toContain("geo-frontend(dev->dev, autoMerge=false)");
    expect(prompt).toContain("loop-created PRs");
    expect(prompt).toContain("merge the PR according to that repository's pullRequest policy");
    expect(prompt).not.toContain("Review open loop-created PRs for this repository");
  });

  it("keeps repository PR review base separate from the local switch-back branch", () => {
    const reviewConfig = parseLoopConfigYaml(`
projects:
  - id: placeholder
    name: Placeholder
    path: /repo/placeholder
    agent: codex
    goal: Keep placeholder architecture healthy.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
prReview:
  repositories:
    - id: release-prs
      name: Release PRs
      path: /repo/app
      repo: OctopusGarage/app
      agent: codex
      schedule: "0 2 * * *"
      base: main
      switchBack: dev
      autoMerge: true
`);
    const repository = reviewConfig.prReview.repositories[0];
    if (repository === undefined) throw new Error("expected repository review config");

    const workOrder = buildRepositoryPullRequestReviewWorkOrder({
      config: reviewConfig,
      repository,
      scheduledAt: 1752643800000,
      runId: "1752643800000-release-prs-repo-pr-review",
    });
    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(workOrder.task).toMatchObject({
      kind: "repository-pull-request-review",
      base: "main",
    });
    expect(workOrder.pullRequestPolicy).toMatchObject({ base: "main", switchBack: "dev" });
    expect(prompt).toContain(
      "Review every open pull request in OctopusGarage/app for base branch main",
    );
    expect(prompt).toContain("gh pr list --repo OctopusGarage/app --state open --base main");
    expect(prompt).toContain("git switch dev");
    expect(prompt).toContain("git pull --ff-only origin dev");
  });

  it("syncs the configured switchBack branch when a PR policy defines one", () => {
    const project = {
      ...firstProject(),
      pullRequest: {
        enabled: true,
        base: "dev",
        switchBack: "release",
        autoMerge: true,
        githubAccount: "Kingson4Wu",
      },
    };
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("git fetch origin release");
    expect(prompt).toContain("git switch release");
    expect(prompt).toContain("git pull --ff-only origin release");
    expect(prompt).toContain("gh auth token --user 'Kingson4Wu'");
    expect(prompt).toContain("do not rely on the global gh active account");
  });

  it("parses the final marker and JSON summary", () => {
    const result = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.status).toBe("completed");
      expect(result.summary.finalVerification).toBe("passed");
    }
  });

  it("normalizes structured final verification from supervisor output", () => {
    const result = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":[],"finalVerification":{"git":"clean","assessment":"score=95"},"commits":[],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.finalVerification).toBe("passed");
    }
  });

  it("normalizes common successful supervisor status aliases", () => {
    const passed = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        '{"status":"passed","projectId":"datavibe","actionsTaken":["score=95"],"delegatedTasks":[{"projectId":"datavibe","status":"complete"}],"finalVerification":"passed","commits":[],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );
    const complete = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-2]",
        '{"status":"complete","projectId":"datavibe","actionsTaken":["score=95"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
      ].join("\n"),
      "wo-2",
    );

    expect(passed.ok).toBe(true);
    if (passed.ok) {
      expect(passed.summary.status).toBe("completed");
      expect(passed.summary.delegatedTasks).toEqual([
        { projectId: "datavibe", status: "complete" },
      ]);
    }
    expect(complete.ok).toBe(true);
    if (complete.ok) {
      expect(complete.summary.status).toBe("completed");
    }
  });

  it("accepts delegated task descriptions in supervisor summaries", () => {
    const result = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":["Round 1: narrowed a module"],"finalVerification":"passed","commits":[],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.delegatedTasks).toEqual(["Round 1: narrowed a module"]);
    }
  });

  it("accepts descriptive delegated task record statuses in supervisor summaries", () => {
    const result = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":[{"projectId":"datavibe","status":"interrupted-read-only-discovery-after-local-report-completed"}],"finalVerification":"passed","commits":[],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.delegatedTasks).toEqual([
        {
          projectId: "datavibe",
          status: "interrupted-read-only-discovery-after-local-report-completed",
        },
      ]);
    }
  });

  it("accepts delegated task records with round, agent, task, and result details", () => {
    const result = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        JSON.stringify({
          status: "completed",
          projectId: "datavibe",
          actionsTaken: ["verified"],
          delegatedTasks: [
            {
              round: 1,
              agent: "codex",
              task: "Inspect coverage gaps and add meaningful tests only.",
              result: "Added focused adapter tests.",
            },
          ],
          finalVerification: "passed",
          commits: [],
          followUps: [],
        }),
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.delegatedTasks).toEqual([
        "Round 1: Inspect coverage gaps and add meaningful tests only. Result: Added focused adapter tests.",
      ]);
    }
  });

  it("renders a finalization prompt when supervisor output misses the final marker", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: firstProject(),
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe",
    });

    const prompt = buildLoopSupervisorFinalizationPrompt(workOrder, "target agent verified slice");

    expect(prompt).toContain("did not include a parseable final summary");
    expect(prompt).toContain("target agent verified slice");
    expect(prompt).toContain("Do not narrate progress in this response.");
    expect(prompt).toContain(
      'status must be exactly one of: "completed", "blocked", "failed", "timeout", "cancelled"',
    );
    expect(prompt).toContain('Use "completed" for successful no-op runs');
    expect(prompt).toContain('finalVerification must be one string only: "passed"');
    expect(prompt).toContain(finalMarkerForWorkOrder("1752643800000-datavibe"));
  });

  it("renders a system validation revision prompt for the same work order", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: firstProject(),
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe",
    });

    const prompt = buildLoopSupervisorRevisionPrompt({
      workOrder,
      failures: ["worktree is dirty after supervisor completion: M src/dirty.ts"],
      attempt: 1,
      maxAttempts: 3,
      previousOutput: "previous supervisor output",
    });

    expect(prompt).toContain("System validation failed for this same WorkOrder");
    expect(prompt).toContain("Revision attempt: 1 of 3");
    expect(prompt).toContain("worktree is dirty after supervisor completion");
    expect(prompt).toContain("Fix only the listed validation failures");
    expect(prompt).toContain("do not start a new task, branch, or PR");
    expect(prompt).toContain("Keep the original WorkOrder id, branch, PR, and final marker");
    expect(prompt).toContain(finalMarkerForWorkOrder("1752643800000-datavibe"));
  });

  it("parses the JSON summary after the last matching final marker", () => {
    const marker = "[LOOP_SUPERVISOR_DONE:wo-1]";
    const result = parseSupervisorFinalSummary(
      [
        "earlier transcript echoed the marker",
        marker,
        '{"status":"failed","projectId":"datavibe","actionsTaken":[],"delegatedTasks":[],"finalVerification":"failed","commits":[],"followUps":[]}',
        "real final summary follows",
        marker,
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.status).toBe("completed");
      expect(result.summary.commits).toEqual(["abc123"]);
    }
  });

  it("rejects a summary with an invalid status", () => {
    expect(
      parseSupervisorFinalSummary(
        [
          "[LOOP_SUPERVISOR_DONE:wo-1]",
          '{"status":"done","projectId":"datavibe","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
        ].join("\n"),
        "wo-1",
      ),
    ).toEqual({
      ok: false,
      reason: "invalid-summary",
    });
  });

  it("rejects output without the expected final marker", () => {
    expect(parseSupervisorFinalSummary("{}", "wo-1")).toEqual({
      ok: false,
      reason: "missing-final-marker",
    });
  });
});
