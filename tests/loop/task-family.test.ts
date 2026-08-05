import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  LOOP_TASK_FAMILY_GOVERNANCE,
  LOOP_WORK_ORDER_TASK_KINDS,
  loopTaskFamilyGovernance,
  projectScheduledJobKinds,
  projectScheduledJobs,
  workspaceScheduledJobKinds,
  workspaceScheduledJobs,
} from "../../src/core/loop/task-family.js";

const allScheduledConfig = `
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    schedule: "0 2 * * *"
    scheduleJitterMinutes: 3
    runner:
      kind: agent-supervised
    goal: Improve hub.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    bugFix:
      enabled: true
      schedule: "10 2 * * *"
      scheduleJitterMinutes: 4
    testCoverage:
      enabled: true
      schedule: "20 2 * * *"
      scheduleJitterMinutes: 5
    securityMaintenance:
      enabled: true
      schedule: "30 2 * * *"
      scheduleJitterMinutes: 6
    harnessAuto:
      enabled: true
      schedule: "40 2 * * *"
      scheduleJitterMinutes: 7
      tasks:
        - kind: bug-fix
          enabled: true
    opportunityDiscovery:
      enabled: true
      schedule: "50 2 * * *"
      scheduleJitterMinutes: 8
    automationGovernanceReview:
      enabled: true
      schedule: "52 2 * * *"
      scheduleJitterMinutes: 9
    pullRequest:
      enabled: true
      base: main
      switchBack: main
    pullRequestReview:
      enabled: true
      schedule: "55 2 * * *"
      scheduleJitterMinutes: 10
workspaces:
  - id: geo
    name: Geo
    root: /repo/geo
    agent: codex
    runner:
      kind: agent-supervised
    repositories:
      - id: geo-api
        name: Geo API
        path: /repo/geo/api
        role: backend
        agent: codex
        pullRequest:
          enabled: true
          base: main
          switchBack: main
      - id: geo-web
        name: Geo Web
        path: /repo/geo/web
        role: frontend
        agent: codex
        pullRequest:
          enabled: false
    architecture:
      enabled: true
      schedule: "0 3 * * *"
      scheduleJitterMinutes: 10
      goal: Improve workspace architecture.
    bugFix:
      enabled: true
      schedule: "10 3 * * *"
      scheduleJitterMinutes: 11
    testCoverage:
      enabled: true
      schedule: "20 3 * * *"
      scheduleJitterMinutes: 12
    securityMaintenance:
      enabled: true
      schedule: "30 3 * * *"
      scheduleJitterMinutes: 13
    harnessAuto:
      enabled: true
      schedule: "40 3 * * *"
      scheduleJitterMinutes: 14
      tasks:
        - kind: architecture
          enabled: true
    opportunityDiscovery:
      enabled: true
      schedule: "50 3 * * *"
      scheduleJitterMinutes: 15
    pullRequestReview:
      enabled: true
      schedule: "55 3 * * *"
      scheduleJitterMinutes: 16
`;

describe("loop task family registry", () => {
  it("defines governance metadata for every WorkOrder task kind", () => {
    expect(Object.keys(LOOP_TASK_FAMILY_GOVERNANCE).sort()).toEqual(
      [...LOOP_WORK_ORDER_TASK_KINDS].sort(),
    );
    expect(loopTaskFamilyGovernance("opportunity-discovery")).toMatchObject({
      actionScope: "read-only",
      ownerConfirmation: "required-before-dispatch",
      defaultWorktreeIsolation: "source-allowed-read-only",
    });
    expect(loopTaskFamilyGovernance("automation-governance-review")).toMatchObject({
      actionScope: "pr-creation",
      requiresPlanning: true,
      requiresAiEval: true,
    });
    expect(loopTaskFamilyGovernance("active-delegated-task")).toMatchObject({
      scheduled: false,
      ownerConfirmation: "optional",
      requiresPlanning: true,
    });
  });

  it("keeps non-scheduled WorkOrder kinds out of scheduled registries", () => {
    const config = parseLoopConfigYaml(allScheduledConfig);
    const project = config.projects[0];
    const workspace = config.workspaces[0];
    if (!project || !workspace) throw new Error("expected scheduled fixtures");

    expect(projectScheduledJobKinds(project)).not.toContain("active-delegated-task");
    expect(workspaceScheduledJobKinds(workspace)).not.toContain("repository-pull-request-review");
  });

  it("derives project scheduled job summaries and scheduler jobs from one ordered registry", () => {
    const project = parseLoopConfigYaml(allScheduledConfig).projects[0];
    if (!project) throw new Error("expected project fixture");

    expect(projectScheduledJobKinds(project)).toEqual([
      "architecture",
      "bug-fix",
      "test-coverage",
      "security-maintenance",
      "harness-auto",
      "opportunity-discovery",
      "automation-governance-review",
      "pull-request-review",
    ]);
    expect(projectScheduledJobs(project)).toEqual([
      {
        project,
        jobKey: "hub",
        jobKind: "architecture",
        schedule: "0 2 * * *",
        scheduleJitterMinutes: 3,
      },
      {
        project,
        jobKey: "hub:bug-fix",
        jobKind: "bug-fix",
        schedule: "10 2 * * *",
        scheduleJitterMinutes: 4,
      },
      {
        project,
        jobKey: "hub:test-coverage",
        jobKind: "test-coverage",
        schedule: "20 2 * * *",
        scheduleJitterMinutes: 5,
      },
      {
        project,
        jobKey: "hub:security-maintenance",
        jobKind: "security-maintenance",
        schedule: "30 2 * * *",
        scheduleJitterMinutes: 6,
      },
      {
        project,
        jobKey: "hub:harness-auto",
        jobKind: "harness-auto",
        schedule: "40 2 * * *",
        scheduleJitterMinutes: 7,
      },
      {
        project,
        jobKey: "hub:opportunity-discovery",
        jobKind: "opportunity-discovery",
        schedule: "50 2 * * *",
        scheduleJitterMinutes: 8,
      },
      {
        project,
        jobKey: "hub:automation-governance-review",
        jobKind: "automation-governance-review",
        schedule: "52 2 * * *",
        scheduleJitterMinutes: 9,
      },
      {
        project,
        jobKey: "hub:pull-request-review",
        jobKind: "pull-request-review",
        schedule: "55 2 * * *",
        scheduleJitterMinutes: 10,
      },
    ]);
  });

  it("derives workspace scheduled job summaries and scheduler jobs from one ordered registry", () => {
    const workspace = parseLoopConfigYaml(allScheduledConfig).workspaces[0];
    if (!workspace) throw new Error("expected workspace fixture");

    expect(workspaceScheduledJobKinds(workspace)).toEqual([
      "architecture",
      "bug-fix",
      "test-coverage",
      "security-maintenance",
      "harness-auto",
      "opportunity-discovery",
      "pull-request-review",
    ]);
    expect(workspaceScheduledJobs(workspace)).toEqual([
      {
        project: workspace,
        jobKey: "workspace:geo:architecture",
        jobKind: "workspace-architecture",
        schedule: "0 3 * * *",
        scheduleJitterMinutes: 10,
      },
      {
        project: workspace,
        jobKey: "workspace:geo:bug-fix",
        jobKind: "bug-fix",
        schedule: "10 3 * * *",
        scheduleJitterMinutes: 11,
      },
      {
        project: workspace,
        jobKey: "workspace:geo:test-coverage",
        jobKind: "test-coverage",
        schedule: "20 3 * * *",
        scheduleJitterMinutes: 12,
      },
      {
        project: workspace,
        jobKey: "workspace:geo:security-maintenance",
        jobKind: "security-maintenance",
        schedule: "30 3 * * *",
        scheduleJitterMinutes: 13,
      },
      {
        project: workspace,
        jobKey: "workspace:geo:harness-auto",
        jobKind: "harness-auto",
        schedule: "40 3 * * *",
        scheduleJitterMinutes: 14,
      },
      {
        project: workspace,
        jobKey: "workspace:geo:opportunity-discovery",
        jobKind: "opportunity-discovery",
        schedule: "50 3 * * *",
        scheduleJitterMinutes: 15,
      },
      {
        project: workspace,
        jobKey: "workspace:geo:pull-request-review",
        jobKind: "pull-request-review",
        schedule: "55 3 * * *",
        scheduleJitterMinutes: 16,
      },
    ]);
  });
});
