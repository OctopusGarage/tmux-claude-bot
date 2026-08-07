import type { TaskCapabilityDependency } from "../capabilities/types.js";
import type { LoopConfig } from "./config.js";

export const LOOP_SCHEDULED_JOB_KINDS = [
  "architecture",
  "bug-fix",
  "test-coverage",
  "security-maintenance",
  "harness-auto",
  "opportunity-discovery",
  "automation-governance-review",
  "pull-request-review",
] as const;

export type LoopScheduledJobKind = (typeof LOOP_SCHEDULED_JOB_KINDS)[number];

export const LOOP_TASK_SCHEDULER_JOB_KINDS = [
  ...LOOP_SCHEDULED_JOB_KINDS,
  "workspace-architecture",
  "repository-pull-request-review",
] as const;

export type LoopTaskSchedulerJobKind = (typeof LOOP_TASK_SCHEDULER_JOB_KINDS)[number];

export const LOOP_WORK_ORDER_TASK_KINDS = [
  "architecture",
  "workspace-architecture",
  "bug-fix",
  "test-coverage",
  "security-maintenance",
  "harness-auto",
  "opportunity-discovery",
  "automation-governance-review",
  "pull-request-review",
  "repository-pull-request-review",
  "active-delegated-task",
] as const;

export type LoopWorkOrderTaskKind = (typeof LOOP_WORK_ORDER_TASK_KINDS)[number];

export type LoopTaskFamilyGovernance = {
  kind: LoopWorkOrderTaskKind;
  promptId?: string;
  scheduled: boolean;
  workspaceSupported: boolean;
  actionScope: "read-only" | "code-change" | "commit" | "pr-creation" | "auto-merge";
  ownerConfirmation: "not-applicable" | "optional" | "required-before-dispatch";
  requiresPlanning: boolean;
  requiresAiEval: boolean;
  defaultWorktreeIsolation: "source-allowed-read-only" | "isolated" | "policy-controlled";
  capabilities: TaskCapabilityDependency[];
  stopRule: string;
};

export const LOOP_TASK_FAMILY_GOVERNANCE: Record<LoopWorkOrderTaskKind, LoopTaskFamilyGovernance> =
  {
    architecture: {
      kind: "architecture",
      promptId: "loop.policy.architecture",
      scheduled: true,
      workspaceSupported: false,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [
        {
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
          level: "recommended",
          phase: "assessment",
          reason:
            "Strengthens architecture discovery and scoring when the active agent has the skill installed.",
        },
        {
          capabilityId: "skill:mattpocock:code-review",
          level: "optional",
          phase: "review",
          reason:
            "Adds review discipline for architecture PRs, but the governed prompt must still work without it.",
        },
      ],
      stopRule:
        "Stop when the configured architecture target score is reached or no bounded improvement remains.",
    },
    "workspace-architecture": {
      kind: "workspace-architecture",
      promptId: "loop.policy.workspace-architecture",
      scheduled: true,
      workspaceSupported: true,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [
        {
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
          level: "recommended",
          phase: "assessment",
          reason:
            "Strengthens cross-repository architecture discovery when the active agent has the skill installed.",
        },
      ],
      stopRule:
        "Stop when the workspace architecture target score is reached or further changes would force unrelated repositories to change.",
    },
    "bug-fix": {
      kind: "bug-fix",
      promptId: "loop.policy.bug-fix",
      scheduled: true,
      workspaceSupported: true,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [],
      stopRule: "Fix only confirmed bugs and stop when a round finds no confirmed real bug.",
    },
    "test-coverage": {
      kind: "test-coverage",
      promptId: "loop.policy.test-coverage",
      scheduled: true,
      workspaceSupported: true,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [
        {
          capabilityId: "skill:mattpocock:tdd",
          level: "recommended",
          phase: "execution",
          reason:
            "Keeps test-coverage work test-first and discourages brittle coverage padding when available.",
        },
      ],
      stopRule:
        "Stop when meaningful coverage reaches the configured target or only brittle/padding tests remain.",
    },
    "security-maintenance": {
      kind: "security-maintenance",
      promptId: "loop.policy.security-maintenance",
      scheduled: true,
      workspaceSupported: true,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [],
      stopRule:
        "Fix only verified security risks and stop when no bounded, verifiable risk remains.",
    },
    "harness-auto": {
      kind: "harness-auto",
      promptId: "loop.policy.harness-auto",
      scheduled: true,
      workspaceSupported: true,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [],
      stopRule:
        "Run only enabled subtasks and stop when the configured health score and no-confirmed-issues condition are met.",
    },
    "opportunity-discovery": {
      kind: "opportunity-discovery",
      promptId: "loop.policy.opportunity-discovery",
      scheduled: true,
      workspaceSupported: true,
      actionScope: "read-only",
      ownerConfirmation: "required-before-dispatch",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "source-allowed-read-only",
      capabilities: [
        {
          capabilityId: "skill:mattpocock:code-review",
          level: "optional",
          phase: "assessment",
          reason:
            "Can improve opportunity triage quality, but discovery remains read-only and bounded without it.",
        },
      ],
      stopRule: "Stop after recording bounded proposals; never implement from discovery.",
    },
    "automation-governance-review": {
      kind: "automation-governance-review",
      promptId: "loop.policy.automation-governance-review",
      scheduled: true,
      workspaceSupported: false,
      actionScope: "pr-creation",
      ownerConfirmation: "not-applicable",
      requiresPlanning: true,
      requiresAiEval: true,
      defaultWorktreeIsolation: "policy-controlled",
      capabilities: [],
      stopRule:
        "Stop at the target governance score; create at most one repair PR for confirmed P0/P1 issues and never auto-merge it.",
    },
    "pull-request-review": {
      kind: "pull-request-review",
      promptId: "loop.policy.pull-request-review",
      scheduled: true,
      workspaceSupported: true,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [
        {
          capabilityId: "skill:mattpocock:code-review",
          level: "recommended",
          phase: "review",
          reason: "Strengthens objective PR review before deciding to close, repair, or merge.",
        },
      ],
      stopRule:
        "Merge only objectively eligible PRs after the configured consecutive review passes.",
    },
    "repository-pull-request-review": {
      kind: "repository-pull-request-review",
      promptId: "loop.policy.repository-pull-request-review",
      scheduled: true,
      workspaceSupported: false,
      actionScope: "auto-merge",
      ownerConfirmation: "not-applicable",
      requiresPlanning: false,
      requiresAiEval: false,
      defaultWorktreeIsolation: "isolated",
      capabilities: [
        {
          capabilityId: "skill:mattpocock:code-review",
          level: "recommended",
          phase: "review",
          reason:
            "Strengthens repository-wide PR review before deciding to close, repair, or merge.",
        },
      ],
      stopRule:
        "Close or merge only after objective review determines the PR is unnecessary or eligible.",
    },
    "active-delegated-task": {
      kind: "active-delegated-task",
      promptId: "loop.policy.active-delegated-task",
      scheduled: false,
      workspaceSupported: false,
      actionScope: "auto-merge",
      ownerConfirmation: "optional",
      requiresPlanning: true,
      requiresAiEval: true,
      defaultWorktreeIsolation: "policy-controlled",
      capabilities: [],
      stopRule:
        "Stop when the confirmed delegated requirement is implemented and verified, or a concrete blocker is proven.",
    },
  };

export function loopTaskFamilyGovernance(kind: LoopWorkOrderTaskKind): LoopTaskFamilyGovernance {
  return LOOP_TASK_FAMILY_GOVERNANCE[kind];
}

type ScheduledEntity = {
  id: string;
  name: string;
};

export type LoopScheduledJob<Project extends ScheduledEntity = ScheduledEntity> = {
  project: Project;
  jobKey: string;
  jobKind: LoopTaskSchedulerJobKind;
  schedule: string | undefined;
  scheduleJitterMinutes?: number | undefined;
};

type ProjectPolicy = {
  enabled: boolean;
  schedule?: string | undefined;
  scheduleJitterMinutes?: number | undefined;
};

type WorkspacePolicy = ProjectPolicy;

type LoopProjectLike = ScheduledEntity & {
  enabled: boolean;
  schedule?: string | undefined;
  scheduleJitterMinutes?: number | undefined;
  bugFix: ProjectPolicy;
  testCoverage: ProjectPolicy;
  securityMaintenance: ProjectPolicy;
  harnessAuto: ProjectPolicy;
  opportunityDiscovery: ProjectPolicy;
  automationGovernanceReview: ProjectPolicy;
  pullRequestReview: ProjectPolicy;
};

type LoopWorkspaceLike = ScheduledEntity & {
  enabled: boolean;
  architecture: ProjectPolicy;
  bugFix: ProjectPolicy;
  testCoverage: ProjectPolicy;
  securityMaintenance: ProjectPolicy;
  harnessAuto: ProjectPolicy;
  opportunityDiscovery: ProjectPolicy;
  pullRequestReview: ProjectPolicy;
};

type ProjectTaskFamily = {
  summaryKind: LoopScheduledJobKind;
  jobKind: LoopTaskSchedulerJobKind;
  policy: (project: LoopProjectLike) => ProjectPolicy;
  jobKey: (project: LoopProjectLike) => string;
};

type WorkspaceTaskFamily = {
  summaryKind: LoopScheduledJobKind;
  jobKind: LoopTaskSchedulerJobKind;
  policy: (workspace: LoopWorkspaceLike) => WorkspacePolicy;
  jobKey: (workspace: LoopWorkspaceLike) => string;
};

const projectArchitecturePolicy = (project: LoopProjectLike): ProjectPolicy => ({
  enabled: true,
  ...(project.schedule !== undefined ? { schedule: project.schedule } : {}),
  ...(project.scheduleJitterMinutes !== undefined
    ? { scheduleJitterMinutes: project.scheduleJitterMinutes }
    : {}),
});

const workspaceArchitecturePolicy = (workspace: LoopWorkspaceLike): WorkspacePolicy => ({
  enabled: true,
  ...(workspace.architecture.enabled && workspace.architecture.schedule !== undefined
    ? { schedule: workspace.architecture.schedule }
    : {}),
  ...(workspace.architecture.scheduleJitterMinutes !== undefined
    ? { scheduleJitterMinutes: workspace.architecture.scheduleJitterMinutes }
    : {}),
});

const PROJECT_TASK_FAMILIES: readonly ProjectTaskFamily[] = [
  {
    summaryKind: "architecture",
    jobKind: "architecture",
    policy: projectArchitecturePolicy,
    jobKey: (project) => project.id,
  },
  {
    summaryKind: "bug-fix",
    jobKind: "bug-fix",
    policy: (project) => project.bugFix,
    jobKey: (project) => `${project.id}:bug-fix`,
  },
  {
    summaryKind: "test-coverage",
    jobKind: "test-coverage",
    policy: (project) => project.testCoverage,
    jobKey: (project) => `${project.id}:test-coverage`,
  },
  {
    summaryKind: "security-maintenance",
    jobKind: "security-maintenance",
    policy: (project) => project.securityMaintenance,
    jobKey: (project) => `${project.id}:security-maintenance`,
  },
  {
    summaryKind: "harness-auto",
    jobKind: "harness-auto",
    policy: (project) => project.harnessAuto,
    jobKey: (project) => `${project.id}:harness-auto`,
  },
  {
    summaryKind: "opportunity-discovery",
    jobKind: "opportunity-discovery",
    policy: (project) => project.opportunityDiscovery,
    jobKey: (project) => `${project.id}:opportunity-discovery`,
  },
  {
    summaryKind: "automation-governance-review",
    jobKind: "automation-governance-review",
    policy: (project) => project.automationGovernanceReview,
    jobKey: (project) => `${project.id}:automation-governance-review`,
  },
  {
    summaryKind: "pull-request-review",
    jobKind: "pull-request-review",
    policy: (project) => project.pullRequestReview,
    jobKey: (project) => `${project.id}:pull-request-review`,
  },
];

const WORKSPACE_TASK_FAMILIES: readonly WorkspaceTaskFamily[] = [
  {
    summaryKind: "architecture",
    jobKind: "workspace-architecture",
    policy: workspaceArchitecturePolicy,
    jobKey: (workspace) => `workspace:${workspace.id}:architecture`,
  },
  {
    summaryKind: "bug-fix",
    jobKind: "bug-fix",
    policy: (workspace) => workspace.bugFix,
    jobKey: (workspace) => `workspace:${workspace.id}:bug-fix`,
  },
  {
    summaryKind: "test-coverage",
    jobKind: "test-coverage",
    policy: (workspace) => workspace.testCoverage,
    jobKey: (workspace) => `workspace:${workspace.id}:test-coverage`,
  },
  {
    summaryKind: "security-maintenance",
    jobKind: "security-maintenance",
    policy: (workspace) => workspace.securityMaintenance,
    jobKey: (workspace) => `workspace:${workspace.id}:security-maintenance`,
  },
  {
    summaryKind: "harness-auto",
    jobKind: "harness-auto",
    policy: (workspace) => workspace.harnessAuto,
    jobKey: (workspace) => `workspace:${workspace.id}:harness-auto`,
  },
  {
    summaryKind: "opportunity-discovery",
    jobKind: "opportunity-discovery",
    policy: (workspace) => workspace.opportunityDiscovery,
    jobKey: (workspace) => `workspace:${workspace.id}:opportunity-discovery`,
  },
  {
    summaryKind: "pull-request-review",
    jobKind: "pull-request-review",
    policy: (workspace) => workspace.pullRequestReview,
    jobKey: (workspace) => `workspace:${workspace.id}:pull-request-review`,
  },
];

export function projectScheduledJobKinds(project: LoopProjectLike): LoopScheduledJobKind[] {
  if (!project.enabled) return [];
  return PROJECT_TASK_FAMILIES.filter((family) => {
    const policy = family.policy(project);
    return policy.enabled && policy.schedule !== undefined;
  }).map((family) => family.summaryKind);
}

export function workspaceScheduledJobKinds(workspace: LoopWorkspaceLike): LoopScheduledJobKind[] {
  if (!workspace.enabled) return [];
  return WORKSPACE_TASK_FAMILIES.filter((family) => {
    const policy = family.policy(workspace);
    return policy.enabled && policy.schedule !== undefined;
  }).map((family) => family.summaryKind);
}

export function projectScheduledJobs<Project extends LoopProjectLike>(
  project: Project,
): Array<LoopScheduledJob<Project>> {
  if (!project.enabled) return [];
  return PROJECT_TASK_FAMILIES.flatMap((family) => {
    const policy = family.policy(project);
    if (!policy.enabled) return [];
    return [scheduledJob(project, family.jobKey(project), family.jobKind, policy)];
  });
}

export function workspaceScheduledJobs<Workspace extends LoopWorkspaceLike>(
  workspace: Workspace,
): Array<LoopScheduledJob<Workspace>> {
  if (!workspace.enabled) return [];
  return WORKSPACE_TASK_FAMILIES.flatMap((family) => {
    const policy = family.policy(workspace);
    if (!policy.enabled) return [];
    return [scheduledJob(workspace, family.jobKey(workspace), family.jobKind, policy)];
  });
}

/**
 * The complete scheduled-job read model shared by the scheduler and task
 * discovery. Task-family policy, keys, and kinds must not be reconstructed by
 * either caller.
 */
export function loopScheduledJobs(config: LoopConfig): LoopScheduledJob[] {
  return [
    ...config.projects.flatMap(projectScheduledJobs),
    ...config.prReview.repositories
      .filter((repository) => repository.enabled)
      .map((repository) => ({
        project: repository,
        jobKey: `pr-review:${repository.id}`,
        jobKind: "repository-pull-request-review" as const,
        schedule: repository.schedule,
        ...(repository.scheduleJitterMinutes !== undefined
          ? { scheduleJitterMinutes: repository.scheduleJitterMinutes }
          : {}),
      })),
    ...config.workspaces.flatMap(workspaceScheduledJobs),
  ];
}

function scheduledJob<Project extends ScheduledEntity>(
  project: Project,
  jobKey: string,
  jobKind: LoopTaskSchedulerJobKind,
  policy: ProjectPolicy | WorkspacePolicy,
): LoopScheduledJob<Project> {
  return {
    project,
    jobKey,
    jobKind,
    schedule: policy.schedule,
    ...(policy.scheduleJitterMinutes !== undefined
      ? { scheduleJitterMinutes: policy.scheduleJitterMinutes }
      : {}),
  };
}
