import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
  buildLoopWorkOrder,
  buildRepositoryPullRequestReviewWorkOrder,
  buildWorkspaceArchitectureWorkOrder,
  finalMarkerForWorkOrder,
  parseSupervisorFinalSummary,
} from "../../src/core/loop/work-order.js";

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
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("You are the Loop Supervisor for tmux-claude-bot.");
    expect(prompt).toContain("Do not call model-provider APIs.");
    expect(prompt).toContain('send <project> "<task>"');
    expect(prompt).toContain("dashboard --json");
    expect(prompt).toContain("open datavibe --agent codex");
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
    expect(prompt).toContain("Before editing, prove the issue is real");
    expect(prompt).toContain("inspect that boundary before confirming the bug");
    expect(prompt).toContain("perform an independent verification pass");
    expect(prompt).toContain("Add or update a focused regression test");
    expect(prompt).toContain("independently re-check that the original trigger path is blocked");
    expect(prompt).toContain("Stop when a round finds no confirmed real bugs");
    expect(prompt).toContain(
      "control <project> compact --yes before each delegated bug-fix round.",
    );
    expect(prompt).toContain("Focus on scheduler, gate, and state consistency bugs.");
    expect(prompt).toContain("loop/datavibe/bug-fix/1752643800000-datavibe-bug-fix");
    expect(prompt).not.toContain("Architecture target score");
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
        { projectId: "datavibe", status: "completed" },
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
