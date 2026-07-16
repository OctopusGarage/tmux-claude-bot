import { parse } from "yaml";
import { z } from "zod";
import {
  approvedSkillSchema,
  skillAgentSchema,
  skillCatalogEntrySchema,
} from "../skills/schema.js";

const agentSchema = skillAgentSchema;
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

const projectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    agent: agentSchema,
    schedule: z.string().min(1).optional(),
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
    skills: z
      .object({
        applyCommand: z.string().min(1).optional(),
        catalog: z.array(skillCatalogEntrySchema).default([]),
        approved: z.array(approvedSkillSchema).default([]),
      })
      .strict()
      .default({ catalog: [], approved: [] }),
    projects: z.array(projectSchema).min(1),
  })
  .strict();

export type LoopConfig = z.infer<typeof loopConfigSchema>;
export type LoopProjectConfig = LoopConfig["projects"][number];

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
  assessment: { mode: "command" };
  eval: { mode: "command" | "agent" | "none"; minScore: number | null };
  execution: { agent: boolean };
  runner: { kind: "system" | "agent-supervised" };
  commit: { enabled: boolean; perRound: boolean; branch: string | null };
  readiness: { runnable: boolean; issueCount: number; issues: LoopValidationIssue[] };
};

export type LoopValidationSummary = {
  ok: boolean;
  phase: "validate-only";
  projectCount: number;
  catalogSkillCount: number;
  approvedSkillCount: number;
  readinessSummary: {
    runnableProjectCount: number;
    scheduledProjectCount: number;
    issueCount: number;
    errorCount: number;
    warningCount: number;
  };
  projects: LoopProjectValidationSummary[];
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
  for (const [index, skill] of config.skills.approved.entries()) {
    if (isFloatingRef(skill.ref)) {
      errors.push(`skills.approved.${index}.ref: floating skill ref "${skill.ref}" is not allowed`);
    }
  }
  for (const [index, project] of config.projects.entries()) {
    if (project.assessment.agent === true) {
      errors.push(`projects.${index}.assessment.agent is not implemented in phase one`);
    }
    const minScore = project.eval?.minScore;
    if (minScore !== undefined && minScore < project.targetScore) {
      errors.push(`projects.${index}.eval.minScore must be >= targetScore`);
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

export function validateLoopConfig(text: string): LoopValidationSummary {
  const config = parseLoopConfigYaml(text);
  const projects = config.projects.map((project): LoopProjectValidationSummary => {
    const issues = projectIssues(project);
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    return {
      id: project.id,
      name: project.name,
      scheduled: project.schedule !== undefined,
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
  const issues = projects.flatMap((project) => project.readiness.issues);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    ok: errorCount === 0,
    phase: "validate-only",
    projectCount: projects.length,
    catalogSkillCount: config.skills.catalog.length,
    approvedSkillCount: config.skills.approved.length,
    readinessSummary: {
      runnableProjectCount: projects.filter((project) => project.readiness.runnable).length,
      scheduledProjectCount: projects.filter((project) => project.scheduled).length,
      issueCount: issues.length,
      errorCount,
      warningCount,
    },
    projects,
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
