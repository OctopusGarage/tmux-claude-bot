import { parse } from "yaml";
import { z } from "zod";
import {
  approvedSkillSchema,
  skillAgentSchema,
  skillCatalogEntrySchema,
} from "../skills/schema.js";
import {
  type LoopScheduledJobKind,
  projectScheduledJobKinds,
  workspaceScheduledJobKinds,
} from "./task-family.js";

const agentSchema = skillAgentSchema;
const worktreeIsolationSchema = z.enum(["isolated", "source", "auto"]);
const cleanupPolicySchema = z.enum(["conservative", "balanced", "aggressive"]);
const actionSchema = z.enum([
  "tests",
  "docs",
  "small-refactor",
  "direct-model-api",
  "dependency-upgrade",
  "broad-rewrite",
]);

const commandBoundarySchema = z
  .object({
    command: z.string().min(1).optional(),
    agent: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => value.command !== undefined || value.agent === true, {
    message: "command or agent is required",
  })
  .refine((value) => !(value.command !== undefined && value.agent === true), {
    message: "choose command or agent, not both",
  });

const preflightSchema = z
  .object({
    commands: z.array(z.string().min(1)).default([]),
    repair: z
      .object({
        agent: z.boolean().default(false),
        prompt: z.string().min(1).optional(),
      })
      .strict()
      .default({ agent: false }),
  })
  .strict()
  .default({ commands: [], repair: { agent: false } });

const recoverySchema = z
  .object({
    agent: z.boolean().default(false),
    dirtyWorktree: z.boolean().default(false),
    maxAttempts: z.number().int().min(0).default(1),
  })
  .strict()
  .default({ agent: false, dirtyWorktree: false, maxAttempts: 1 });

const runnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }).strict(),
  z
    .object({
      kind: z.literal("agent-supervised"),
      timeoutMs: z.number().int().positive().optional(),
      maxTurns: z.number().int().positive().optional(),
      requireConfirmation: z.boolean().default(false),
    })
    .strict(),
]);

const pullRequestReviewSchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    lookbackHours: z.number().int().positive().default(36),
    consecutivePasses: z.number().int().positive().default(2),
    autoMerge: z.boolean().default(false),
    prompt: z.string().min(1).optional(),
  })
  .strict()
  .default({ enabled: false, lookbackHours: 36, consecutivePasses: 2, autoMerge: false });

const bugFixSchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    branch: z.string().min(1).optional(),
    maxRounds: z.number().int().positive().default(3),
    maxBugsPerRound: z.number().int().positive().default(2),
    requireRegressionTest: z.boolean().default(true),
    cleanupPolicy: cleanupPolicySchema.optional(),
    prompt: z.string().min(1).optional(),
  })
  .strict()
  .default({
    enabled: false,
    maxRounds: 3,
    maxBugsPerRound: 2,
    requireRegressionTest: true,
  });

const testCoverageSchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    branch: z.string().min(1).optional(),
    targetCoverage: z.number().int().min(0).max(100).default(80),
    maxRounds: z.number().int().positive().default(5),
    requireMeaningfulTests: z.boolean().default(true),
    allowIntegrationTests: z.boolean().default(true),
    allowSmokeTests: z.boolean().default(true),
    allowE2ETests: z.boolean().default(true),
    allowAiEvalTests: z.boolean().default(true),
    cleanupPolicy: cleanupPolicySchema.optional(),
    prompt: z.string().min(1).optional(),
  })
  .strict()
  .default({
    enabled: false,
    targetCoverage: 80,
    maxRounds: 5,
    requireMeaningfulTests: true,
    allowIntegrationTests: true,
    allowSmokeTests: true,
    allowE2ETests: true,
    allowAiEvalTests: true,
  });

const securityMaintenanceSchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    branch: z.string().min(1).optional(),
    maxRounds: z.number().int().positive().default(3),
    allowDependencyUpdates: z.boolean().default(true),
    allowConfigHardening: z.boolean().default(true),
    allowStaticAnalysisFixes: z.boolean().default(true),
    cleanupPolicy: cleanupPolicySchema.optional(),
    prompt: z.string().min(1).optional(),
  })
  .strict()
  .default({
    enabled: false,
    maxRounds: 3,
    allowDependencyUpdates: true,
    allowConfigHardening: true,
    allowStaticAnalysisFixes: true,
  });

const harnessAutoTaskKindSchema = z.enum([
  "architecture",
  "bug-fix",
  "test-coverage",
  "security-maintenance",
]);

const harnessAutoSchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    branch: z.string().min(1).optional(),
    maxRounds: z.number().int().positive().default(3),
    strategy: z.enum(["health-first", "risk-first", "configured-order"]).default("health-first"),
    tasks: z
      .array(
        z
          .object({
            kind: harnessAutoTaskKindSchema,
            enabled: z.boolean().default(true),
            weight: z.number().int().positive().default(1),
          })
          .strict(),
      )
      .default([
        { kind: "bug-fix", enabled: true, weight: 40 },
        { kind: "security-maintenance", enabled: true, weight: 30 },
        { kind: "test-coverage", enabled: true, weight: 20 },
        { kind: "architecture", enabled: true, weight: 10 },
      ]),
    stopWhen: z
      .object({
        healthScoreAtLeast: z.number().int().min(0).max(100).default(95),
        noConfirmedIssues: z.boolean().default(true),
      })
      .strict()
      .default({ healthScoreAtLeast: 95, noConfirmedIssues: true }),
    cleanupPolicy: cleanupPolicySchema.optional(),
    prompt: z.string().min(1).optional(),
  })
  .strict()
  .default({
    enabled: false,
    maxRounds: 3,
    strategy: "health-first",
    tasks: [
      { kind: "bug-fix", enabled: true, weight: 40 },
      { kind: "security-maintenance", enabled: true, weight: 30 },
      { kind: "test-coverage", enabled: true, weight: 20 },
      { kind: "architecture", enabled: true, weight: 10 },
    ],
    stopWhen: { healthScoreAtLeast: 95, noConfirmedIssues: true },
  });

const opportunityCategorySchema = z.enum([
  "product-feature",
  "workflow-automation",
  "developer-experience",
  "reliability",
  "architecture",
  "testing",
  "security",
]);

const opportunityDiscoverySchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    notificationChannel: z.enum(["telegram", "lark", "both"]).optional(),
    maxSuggestions: z.number().int().min(1).max(5).default(3),
    minConfidence: z.enum(["low", "medium", "high"]).default("medium"),
    categories: z
      .array(opportunityCategorySchema)
      .default(["product-feature", "workflow-automation", "developer-experience", "reliability"]),
    cooldownDays: z.number().int().min(0).max(365).default(14),
    requireEvidence: z.boolean().default(true),
    prompt: z.string().min(1).optional(),
  })
  .strict()
  .default({
    enabled: false,
    maxSuggestions: 3,
    minConfidence: "medium",
    categories: ["product-feature", "workflow-automation", "developer-experience", "reliability"],
    cooldownDays: 14,
    requireEvidence: true,
  });

const repositoryPullRequestReviewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    repo: z.string().min(1),
    agent: agentSchema,
    schedule: z.string().min(1),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    base: z.string().min(1).optional(),
    switchBack: z.string().min(1).optional(),
    githubAccount: z.string().min(1).optional(),
    lookbackHours: z.number().int().positive().default(72),
    consecutivePasses: z.number().int().positive().default(2),
    autoMerge: z.boolean().default(false),
    repair: z
      .object({
        enabled: z.boolean().default(true),
        maxAttempts: z.number().int().min(0).max(3).default(1),
        prompt: z.string().min(1).optional(),
      })
      .strict()
      .default({ enabled: true, maxAttempts: 1 }),
    prompt: z.string().min(1).optional(),
    worktreeIsolation: worktreeIsolationSchema.optional(),
    runner: runnerSchema.default({ kind: "agent-supervised", requireConfirmation: false }),
  })
  .strict()
  .transform((repo) => ({
    ...repo,
    switchBack: repo.switchBack ?? repo.base ?? "main",
  }));

const workspaceRepositorySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    role: z.string().min(1),
    agent: agentSchema.optional(),
    worktreeIsolation: worktreeIsolationSchema.optional(),
    pullRequest: z
      .object({
        enabled: z.boolean().default(false),
        base: z.string().min(1).default("main"),
        switchBack: z.string().min(1).default("main"),
        autoMerge: z.boolean().default(false),
        githubAccount: z.string().min(1).optional(),
      })
      .strict()
      .default({ enabled: false, base: "main", switchBack: "main", autoMerge: false }),
  })
  .strict();

const workspaceArchitectureSchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    goal: z.string().min(1),
    maxRounds: z.number().int().positive().default(3),
    targetScore: z.number().int().min(0).max(100).default(95),
    cleanupPolicy: cleanupPolicySchema.optional(),
    prompt: z.string().min(1).optional(),
    runner: runnerSchema.default({ kind: "agent-supervised", requireConfirmation: false }),
  })
  .strict();

const workspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    root: z.string().min(1),
    agent: agentSchema,
    runner: runnerSchema.default({ kind: "agent-supervised", requireConfirmation: false }),
    worktreeIsolation: worktreeIsolationSchema.optional(),
    cleanupPolicy: cleanupPolicySchema.default("conservative"),
    repositories: z.array(workspaceRepositorySchema).min(2),
    architecture: workspaceArchitectureSchema,
    bugFix: bugFixSchema,
    testCoverage: testCoverageSchema,
    securityMaintenance: securityMaintenanceSchema,
    harnessAuto: harnessAutoSchema,
    opportunityDiscovery: opportunityDiscoverySchema,
    pullRequestReview: pullRequestReviewSchema,
    allowedActions: z.array(actionSchema).default(["tests", "docs", "small-refactor"]),
    blockedActions: z
      .array(actionSchema)
      .default(["direct-model-api", "dependency-upgrade", "broad-rewrite"]),
  })
  .strict();

const projectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    agent: agentSchema,
    worktreeIsolation: worktreeIsolationSchema.optional(),
    cleanupPolicy: cleanupPolicySchema.default("conservative"),
    schedule: z.string().min(1).optional(),
    scheduleJitterMinutes: z.number().int().min(0).max(240).optional(),
    goal: z.string().min(1),
    maxRounds: z.number().int().positive(),
    targetScore: z.number().int().min(0).max(100),
    assessment: commandBoundarySchema,
    preflight: preflightSchema,
    eval: commandBoundarySchema
      .extend({
        minScore: z.number().int().min(0).max(100).optional(),
      })
      .optional(),
    execution: z
      .object({
        agent: z.boolean().default(false),
      })
      .strict()
      .default({ agent: false }),
    runner: runnerSchema.default({ kind: "system" }),
    recovery: recoverySchema,
    commit: z
      .object({
        enabled: z.boolean().default(false),
        perRound: z.boolean().default(true),
        branch: z.string().min(1).optional(),
      })
      .strict()
      .default({ enabled: false, perRound: true }),
    pullRequest: z
      .object({
        enabled: z.boolean().default(false),
        base: z.string().min(1).default("main"),
        switchBack: z.string().min(1).default("main"),
        autoMerge: z.boolean().default(false),
        githubAccount: z.string().min(1).optional(),
      })
      .strict()
      .default({ enabled: false, base: "main", switchBack: "main", autoMerge: false }),
    bugFix: bugFixSchema,
    testCoverage: testCoverageSchema,
    securityMaintenance: securityMaintenanceSchema,
    harnessAuto: harnessAutoSchema,
    opportunityDiscovery: opportunityDiscoverySchema,
    pullRequestReview: pullRequestReviewSchema,
    allowedActions: z.array(actionSchema).default([]),
    blockedActions: z.array(actionSchema).default([]),
    selfImprovement: z
      .object({
        enabled: z.boolean().default(true),
        maxItemsPerRun: z.number().int().positive().optional(),
      })
      .strict()
      .default({ enabled: true }),
  })
  .strict();

const loopConfigSchema = z
  .object({
    scheduler: z
      .object({
        jitter: z
          .object({
            enabled: z.boolean().default(false),
            seed: z.string().min(1).default("loop-engineering"),
            architectureMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
            bugFixMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
            testCoverageMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
            securityMaintenanceMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
            harnessAutoMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
            opportunityDiscoveryMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
            pullRequestReviewMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
            repositoryPullRequestReviewMaxDelayMinutes: z.number().int().min(0).max(240).default(0),
          })
          .strict()
          .default({
            enabled: false,
            seed: "loop-engineering",
            architectureMaxDelayMinutes: 0,
            bugFixMaxDelayMinutes: 0,
            testCoverageMaxDelayMinutes: 0,
            securityMaintenanceMaxDelayMinutes: 0,
            harnessAutoMaxDelayMinutes: 0,
            opportunityDiscoveryMaxDelayMinutes: 0,
            pullRequestReviewMaxDelayMinutes: 0,
            repositoryPullRequestReviewMaxDelayMinutes: 0,
          }),
      })
      .strict()
      .default({
        jitter: {
          enabled: false,
          seed: "loop-engineering",
          architectureMaxDelayMinutes: 0,
          bugFixMaxDelayMinutes: 0,
          testCoverageMaxDelayMinutes: 0,
          securityMaintenanceMaxDelayMinutes: 0,
          harnessAutoMaxDelayMinutes: 0,
          opportunityDiscoveryMaxDelayMinutes: 0,
          pullRequestReviewMaxDelayMinutes: 0,
          repositoryPullRequestReviewMaxDelayMinutes: 0,
        },
      }),
    skills: z
      .object({
        applyCommand: z.string().min(1).optional(),
        catalog: z.array(skillCatalogEntrySchema).default([]),
        approved: z.array(approvedSkillSchema).default([]),
      })
      .strict()
      .default({ catalog: [], approved: [] }),
    projects: z.array(projectSchema).default([]),
    workspaces: z.array(workspaceSchema).default([]),
    prReview: z
      .object({
        repositories: z.array(repositoryPullRequestReviewSchema).default([]),
      })
      .strict()
      .default({ repositories: [] }),
  })
  .strict();

export type LoopConfig = z.infer<typeof loopConfigSchema>;
export type LoopProjectConfig = LoopConfig["projects"][number];
export type LoopWorkspaceConfig = LoopConfig["workspaces"][number];
export type LoopRepositoryPullRequestReviewConfig = LoopConfig["prReview"]["repositories"][number];

export type LoopValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  projectId?: string;
};

export type LoopProjectValidationSummary = {
  id: string;
  name: string;
  scheduled: boolean;
  scheduledJobs: LoopScheduledJobKind[];
  assessment: { mode: "command" };
  eval: { mode: "command" | "agent" | "none"; minScore: number | null };
  execution: { agent: boolean };
  runner: { kind: "system" | "agent-supervised" };
  commit: { enabled: boolean; perRound: boolean; branch: string | null };
  readiness: { runnable: boolean; issueCount: number; issues: LoopValidationIssue[] };
};

export type LoopWorkspaceValidationSummary = {
  id: string;
  name: string;
  repositoryCount: number;
  scheduled: boolean;
  scheduledJobs: LoopScheduledJobKind[];
  runner: { kind: "system" | "agent-supervised" };
  readiness: { runnable: boolean; issueCount: number; issues: LoopValidationIssue[] };
};

export type LoopValidationSummary = {
  ok: boolean;
  phase: "validate-only";
  projectCount: number;
  workspaceCount: number;
  catalogSkillCount: number;
  approvedSkillCount: number;
  readinessSummary: {
    runnableProjectCount: number;
    scheduledProjectCount: number;
    runnableWorkspaceCount: number;
    scheduledWorkspaceCount: number;
    issueCount: number;
    errorCount: number;
    warningCount: number;
  };
  projects: LoopProjectValidationSummary[];
  workspaces: LoopWorkspaceValidationSummary[];
  skills: {
    applyCommandConfigured: boolean;
    approved: Array<{
      id: string;
      sourcePath: string | null;
      platforms: Array<"claude" | "codex">;
      trustLevel: "core" | "approved" | "community";
      risk: "low" | "medium" | "high";
      updatePolicy: "manual" | "notify" | "auto-minor";
    }>;
    catalog: Array<{
      id: string;
      sourcePath: string;
      trackingRef: string;
      platforms: Array<"claude" | "codex">;
      trustLevel: "core" | "approved" | "community";
      risk: "low" | "medium" | "high";
      updatePolicy: "manual" | "notify" | "auto-minor";
    }>;
  };
  issues: LoopValidationIssue[];
};

function issuePath(path: PropertyKey[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

function isFloatingRef(ref: string): boolean {
  return ["main", "master", "HEAD", "latest"].includes(ref);
}

function ensurePhaseOneBoundaries(config: LoopConfig): void {
  const errors: string[] = [];
  if (
    config.projects.length === 0 &&
    config.workspaces.length === 0 &&
    config.prReview.repositories.length === 0
  ) {
    errors.push("at least one project, workspace, or prReview repository is required");
  }
  for (const [index, skill] of config.skills.approved.entries()) {
    if (isFloatingRef(skill.ref)) {
      errors.push(`skills.approved.${index}.ref: floating skill ref "${skill.ref}" is not allowed`);
    }
  }
  for (const [index, project] of config.projects.entries()) {
    if (project.assessment.agent === true) {
      errors.push(`projects.${index}.assessment.agent is not implemented in phase one`);
    }
    if (project.pullRequestReview.enabled) {
      if (project.pullRequestReview.schedule === undefined) {
        errors.push(`projects.${index}.pullRequestReview.schedule is required when enabled`);
      }
      if (project.runner.kind !== "agent-supervised") {
        errors.push(`projects.${index}.pullRequestReview requires runner.kind=agent-supervised`);
      }
      if (!project.pullRequest.enabled) {
        errors.push(`projects.${index}.pullRequestReview requires pullRequest.enabled=true`);
      }
    }
    if (project.bugFix.enabled) {
      if (project.bugFix.schedule === undefined) {
        errors.push(`projects.${index}.bugFix.schedule is required when enabled`);
      }
      if (project.runner.kind !== "agent-supervised") {
        errors.push(`projects.${index}.bugFix requires runner.kind=agent-supervised`);
      }
    }
    if (project.testCoverage.enabled) {
      if (project.testCoverage.schedule === undefined) {
        errors.push(`projects.${index}.testCoverage.schedule is required when enabled`);
      }
      if (project.runner.kind !== "agent-supervised") {
        errors.push(`projects.${index}.testCoverage requires runner.kind=agent-supervised`);
      }
    }
    if (project.securityMaintenance.enabled) {
      if (project.securityMaintenance.schedule === undefined) {
        errors.push(`projects.${index}.securityMaintenance.schedule is required when enabled`);
      }
      if (project.runner.kind !== "agent-supervised") {
        errors.push(`projects.${index}.securityMaintenance requires runner.kind=agent-supervised`);
      }
    }
    if (project.harnessAuto.enabled) {
      if (project.harnessAuto.schedule === undefined) {
        errors.push(`projects.${index}.harnessAuto.schedule is required when enabled`);
      }
      if (project.runner.kind !== "agent-supervised") {
        errors.push(`projects.${index}.harnessAuto requires runner.kind=agent-supervised`);
      }
      if (!project.harnessAuto.tasks.some((task) => task.enabled)) {
        errors.push(`projects.${index}.harnessAuto requires at least one enabled task`);
      }
    }
    if (project.opportunityDiscovery.enabled) {
      if (project.opportunityDiscovery.schedule === undefined) {
        errors.push(`projects.${index}.opportunityDiscovery.schedule is required when enabled`);
      }
      if (project.runner.kind !== "agent-supervised") {
        errors.push(`projects.${index}.opportunityDiscovery requires runner.kind=agent-supervised`);
      }
    }
    const minScore = project.eval?.minScore;
    if (minScore !== undefined && minScore < project.targetScore) {
      errors.push(`projects.${index}.eval.minScore must be >= targetScore`);
    }
  }
  for (const [index, repo] of config.prReview.repositories.entries()) {
    if (repo.runner.kind !== "agent-supervised") {
      errors.push(`prReview.repositories.${index}.runner requires kind=agent-supervised`);
    }
  }
  for (const [index, workspace] of config.workspaces.entries()) {
    if (workspace.architecture.enabled && workspace.architecture.schedule === undefined) {
      errors.push(`workspaces.${index}.architecture.schedule is required when enabled`);
    }
    if (workspace.runner.kind !== "agent-supervised") {
      errors.push(`workspaces.${index}.runner requires kind=agent-supervised`);
    }
    if (
      workspace.architecture.enabled &&
      workspace.architecture.runner.kind !== "agent-supervised"
    ) {
      errors.push(`workspaces.${index}.architecture requires runner.kind=agent-supervised`);
    }
    if (workspace.bugFix.enabled && workspace.bugFix.schedule === undefined) {
      errors.push(`workspaces.${index}.bugFix.schedule is required when enabled`);
    }
    if (workspace.testCoverage.enabled && workspace.testCoverage.schedule === undefined) {
      errors.push(`workspaces.${index}.testCoverage.schedule is required when enabled`);
    }
    if (
      workspace.securityMaintenance.enabled &&
      workspace.securityMaintenance.schedule === undefined
    ) {
      errors.push(`workspaces.${index}.securityMaintenance.schedule is required when enabled`);
    }
    if (workspace.harnessAuto.enabled && workspace.harnessAuto.schedule === undefined) {
      errors.push(`workspaces.${index}.harnessAuto.schedule is required when enabled`);
    }
    if (
      workspace.harnessAuto.enabled &&
      !workspace.harnessAuto.tasks.some((task) => task.enabled)
    ) {
      errors.push(`workspaces.${index}.harnessAuto requires at least one enabled task`);
    }
    if (
      workspace.opportunityDiscovery.enabled &&
      workspace.opportunityDiscovery.schedule === undefined
    ) {
      errors.push(`workspaces.${index}.opportunityDiscovery.schedule is required when enabled`);
    }
    if (workspace.opportunityDiscovery.enabled && workspace.runner.kind !== "agent-supervised") {
      errors.push(`workspaces.${index}.opportunityDiscovery requires runner.kind=agent-supervised`);
    }
    if (workspace.pullRequestReview.enabled) {
      if (workspace.pullRequestReview.schedule === undefined) {
        errors.push(`workspaces.${index}.pullRequestReview.schedule is required when enabled`);
      }
      if (workspace.runner.kind !== "agent-supervised") {
        errors.push(`workspaces.${index}.pullRequestReview requires runner.kind=agent-supervised`);
      }
      if (!workspace.repositories.some((repository) => repository.pullRequest.enabled)) {
        errors.push(
          `workspaces.${index}.pullRequestReview requires at least one repository pullRequest.enabled=true`,
        );
      }
    }
  }
  if (errors.length > 0) throw new Error(`invalid loop config: ${errors.join("; ")}`);
}

export function parseLoopConfigYaml(text: string): LoopConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = loopConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid loop config: ${parsed.error.issues
        .map((issue) => `${issuePath(issue.path)}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  ensurePhaseOneBoundaries(parsed.data);
  return parsed.data;
}

function projectIssues(project: LoopProjectConfig): LoopValidationIssue[] {
  const issues: LoopValidationIssue[] = [];
  if (project.commit.enabled && project.commit.branch === undefined) {
    issues.push({
      severity: "warning",
      code: "missing-commit-branch",
      projectId: project.id,
      message: "commit.enabled is true but no branch is configured.",
    });
  }
  return issues;
}

function workspaceIssues(_workspace: LoopWorkspaceConfig): LoopValidationIssue[] {
  return [];
}

function scheduledProjectJobs(project: LoopProjectConfig): LoopScheduledJobKind[] {
  return projectScheduledJobKinds(project);
}

function scheduledWorkspaceJobs(workspace: LoopWorkspaceConfig): LoopScheduledJobKind[] {
  return workspaceScheduledJobKinds(workspace);
}

export function validateLoopConfig(text: string): LoopValidationSummary {
  const config = parseLoopConfigYaml(text);
  const projects = config.projects.map((project): LoopProjectValidationSummary => {
    const issues = projectIssues(project);
    const scheduledJobs = scheduledProjectJobs(project);
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    return {
      id: project.id,
      name: project.name,
      scheduled: scheduledJobs.length > 0,
      scheduledJobs,
      assessment: { mode: "command" },
      eval:
        project.eval?.command !== undefined
          ? { mode: "command", minScore: project.eval.minScore ?? null }
          : project.eval?.agent === true
            ? { mode: "agent", minScore: project.eval.minScore ?? null }
            : { mode: "none", minScore: null },
      execution: { agent: project.execution.agent },
      runner: { kind: project.runner.kind },
      commit: {
        enabled: project.commit.enabled,
        perRound: project.commit.perRound,
        branch: project.commit.branch ?? null,
      },
      readiness: {
        runnable: errorCount === 0,
        issueCount: issues.length,
        issues,
      },
    };
  });
  const workspaces = config.workspaces.map((workspace): LoopWorkspaceValidationSummary => {
    const issues = workspaceIssues(workspace);
    const scheduledJobs = scheduledWorkspaceJobs(workspace);
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    return {
      id: workspace.id,
      name: workspace.name,
      repositoryCount: workspace.repositories.length,
      scheduled: scheduledJobs.length > 0,
      scheduledJobs,
      runner: { kind: workspace.runner.kind },
      readiness: {
        runnable: errorCount === 0,
        issueCount: issues.length,
        issues,
      },
    };
  });
  const issues = [
    ...projects.flatMap((project) => project.readiness.issues),
    ...workspaces.flatMap((workspace) => workspace.readiness.issues),
  ];
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    ok: errorCount === 0,
    phase: "validate-only",
    projectCount: projects.length,
    workspaceCount: workspaces.length,
    catalogSkillCount: config.skills.catalog.length,
    approvedSkillCount: config.skills.approved.length,
    readinessSummary: {
      runnableProjectCount: projects.filter((project) => project.readiness.runnable).length,
      scheduledProjectCount: projects.filter((project) => project.scheduled).length,
      runnableWorkspaceCount: workspaces.filter((workspace) => workspace.readiness.runnable).length,
      scheduledWorkspaceCount: workspaces.filter((workspace) => workspace.scheduled).length,
      issueCount: issues.length,
      errorCount,
      warningCount,
    },
    projects,
    workspaces,
    skills: {
      applyCommandConfigured: config.skills.applyCommand !== undefined,
      approved: config.skills.approved.map((skill) => ({
        id: skill.id,
        sourcePath: skill.sourcePath ?? null,
        platforms: skill.platforms,
        trustLevel: skill.trustLevel,
        risk: skill.risk,
        updatePolicy: skill.updatePolicy,
      })),
      catalog: config.skills.catalog.map((skill) => ({
        id: skill.id,
        sourcePath: skill.sourcePath,
        trackingRef: skill.trackingRef,
        platforms: skill.platforms,
        trustLevel: skill.trustLevel,
        risk: skill.risk,
        updatePolicy: skill.updatePolicy,
      })),
    },
    issues,
  };
}
