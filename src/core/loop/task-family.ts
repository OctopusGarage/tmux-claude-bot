export type LoopScheduledJobKind =
  | "architecture"
  | "bug-fix"
  | "test-coverage"
  | "security-maintenance"
  | "harness-auto"
  | "opportunity-discovery"
  | "automation-governance-review"
  | "pull-request-review";

export type LoopTaskSchedulerJobKind =
  | LoopScheduledJobKind
  | "workspace-architecture"
  | "repository-pull-request-review";

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
  return PROJECT_TASK_FAMILIES.filter((family) => {
    const policy = family.policy(project);
    return policy.enabled && policy.schedule !== undefined;
  }).map((family) => family.summaryKind);
}

export function workspaceScheduledJobKinds(workspace: LoopWorkspaceLike): LoopScheduledJobKind[] {
  return WORKSPACE_TASK_FAMILIES.filter((family) => {
    const policy = family.policy(workspace);
    return policy.enabled && policy.schedule !== undefined;
  }).map((family) => family.summaryKind);
}

export function projectScheduledJobs<Project extends LoopProjectLike>(
  project: Project,
): Array<LoopScheduledJob<Project>> {
  return PROJECT_TASK_FAMILIES.flatMap((family) => {
    const policy = family.policy(project);
    if (!policy.enabled) return [];
    return [scheduledJob(project, family.jobKey(project), family.jobKind, policy)];
  });
}

export function workspaceScheduledJobs<Workspace extends LoopWorkspaceLike>(
  workspace: Workspace,
): Array<LoopScheduledJob<Workspace>> {
  return WORKSPACE_TASK_FAMILIES.flatMap((family) => {
    const policy = family.policy(workspace);
    if (!policy.enabled) return [];
    return [scheduledJob(workspace, family.jobKey(workspace), family.jobKind, policy)];
  });
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
