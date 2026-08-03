import { describe, expect, it } from "vitest";
import { type LoopProjectConfig, parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  buildActiveDelegatedTaskWorkOrder,
  buildLoopWorkOrder,
  buildRepositoryPullRequestReviewWorkOrder,
} from "../../src/core/loop/work-order.js";
import {
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
} from "../../src/core/prompts/loop-supervisor.js";

const config = parseLoopConfigYaml(`
projects:
  - id: app
    name: App
    path: /repo/app
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
    goal: Improve architecture.
    maxRounds: 2
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, broad-rewrite]
`);

function project(overrides: Partial<LoopProjectConfig> = {}): LoopProjectConfig {
  const base = config.projects[0];
  if (base === undefined) throw new Error("expected test project");
  return { ...base, ...overrides };
}

describe("loop supervisor prompts", () => {
  it("keeps the supervisor contract explicit and system-gate oriented", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: project(),
      scheduledAt: 1752643800000,
      runId: "1752643800000-app",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("You are the Loop Supervisor for tmux-claude-bot.");
    expect(prompt).toContain("WorkOrder JSON:");
    expect(prompt).toContain("Do not call model-provider APIs.");
    expect(prompt).toContain("Do not add model SDKs");
    expect(prompt).toContain("reviewGate must be an object");
    expect(prompt).toContain("reviewGate.evidence");
    expect(prompt).toContain("questionInvestigated");
    expect(prompt).toContain("learning must classify");
    expect(prompt).toContain("Capability evals are non-blocking learning signals");
    expect(prompt).toContain(
      "Regression evals are blocking only when they protect behavior already accepted as working",
    );
    expect(prompt).toContain("preserve acceptance targets");
    expect(prompt).toContain("Deterministic gates remain authoritative");
    expect(prompt).toContain("long or potentially unbounded verification commands");
    expect(prompt).toContain("portable timeout wrapper");
    expect(prompt).toContain("gh pr diff <number> --name-only");
    expect(prompt).toContain("gh pr diff <number> --patch");
    expect(prompt).toContain(workOrder.requiredFinalMarker);
  });

  it("keeps opportunity discovery read-only", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: project({
        opportunityDiscovery: {
          enabled: true,
          maxSuggestions: 3,
          minConfidence: "medium",
          categories: ["reliability", "testing"],
          cooldownDays: 14,
          requireEvidence: true,
        },
      }),
      jobKind: "opportunity-discovery",
      scheduledAt: 1752643800000,
      runId: "1752643800000-app-opportunity",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("Opportunity discovery task.");
    expect(prompt).toContain("do not edit files, commit, push, create branches");
    expect(prompt).toContain("must not create a branch, commit, PR, or code change");
  });

  it("allows automation governance repair PRs but not auto-merge", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: project({
        automationGovernanceReview: {
          enabled: true,
          allowRepairPr: true,
          targetScore: 90,
          maxFindings: 3,
          requireAiEval: true,
        },
      }),
      jobKind: "automation-governance-review",
      scheduledAt: 1752643800000,
      runId: "1752643800000-app-governance",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("Automation governance review task.");
    expect(prompt).toContain("P0/P1");
    expect(prompt).toContain("create a repair PR");
    expect(prompt).toContain("do not merge it");
  });

  it("requires meaningful maintainable tests for test coverage work", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: project({
        testCoverage: {
          enabled: true,
          targetCoverage: 80,
          maxRounds: 2,
          requireMeaningfulTests: true,
          allowIntegrationTests: true,
          allowSmokeTests: true,
          allowE2ETests: false,
          allowAiEvalTests: true,
        },
      }),
      jobKind: "test-coverage",
      scheduledAt: 1752643800000,
      runId: "1752643800000-app-tests",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("Target effective test coverage is at least 80%");
    expect(prompt).toContain("Do not add padding tests");
    expect(prompt).toContain("professional, elegant, reliable, and clear");
    expect(prompt).toContain("brittle timing");
  });

  it("requires a delegation brief before active delegated task execution", () => {
    const workOrder = buildActiveDelegatedTaskWorkOrder({
      session: "tmux_proj_app",
      projectId: "app",
      projectName: "App",
      projectPath: "/repo/app",
      agent: "codex",
      requirement: "Continue the approved prompt governance cleanup.",
      scheduledAt: 1752643800000,
      runId: "1752643800000-app-active-delegate",
      projectSessionPrefix: "tmux_proj_",
      projectPolicy: project(),
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("Task advancement contract.");
    expect(prompt).toContain("delegationBrief");
    expect(prompt).toContain("currentScore");
    expect(prompt).toContain("targetScore");
    expect(prompt).toContain("taskChecklist");
    expect(prompt).toContain("acceptanceCriteria");
    expect(prompt).toContain("stopConditions");
    expect(prompt).toContain("verificationPlan");
    expect(prompt).toContain("If the active agent surface supports a durable goal command");
    expect(prompt).toContain("planReview");
    expect(prompt).toContain("overOptimizationAvoided");
  });

  it("uses finalization and revision prompts only to complete the same WorkOrder", () => {
    const reviewConfig = parseLoopConfigYaml(`
prReview:
  repositories:
    - id: app
      name: App
      repo: OctopusGarage/app
      path: /repo/app
      agent: codex
      schedule: "0 9 * * *"
      base: dev
      autoMerge: true
      repair:
        enabled: true
        maxAttempts: 1
`);
    const repository = reviewConfig.prReview.repositories[0];
    if (repository === undefined) throw new Error("expected repository review config");
    const workOrder = buildRepositoryPullRequestReviewWorkOrder({
      config: reviewConfig,
      repository,
      scheduledAt: 1752643800000,
      runId: "1752643800000-app-pr-review",
    });

    const finalization = buildLoopSupervisorFinalizationPrompt(workOrder, "missing marker");
    const revision = buildLoopSupervisorRevisionPrompt({
      workOrder,
      failures: ["reviewGate.decision is missing"],
      attempt: 1,
      maxAttempts: 2,
      previousOutput: "bad summary",
    });

    expect(finalization).toContain("did not include a parseable final summary");
    expect(finalization).toContain("Do not narrate progress");
    expect(finalization).toContain("Do not call model-provider APIs");
    expect(finalization).toContain("Do not add model SDKs");
    expect(finalization).toContain(workOrder.requiredFinalMarker);
    expect(revision).toContain("repair only the listed issues");
    expect(revision).toContain("do not start a new task, branch, or PR");
    expect(revision).toContain("Do not call model-provider APIs");
    expect(revision).toContain("Do not add model SDKs");
    expect(revision).toContain("reviewGate.decision is missing");
    expect(revision).toContain(workOrder.requiredFinalMarker);
  });
});
