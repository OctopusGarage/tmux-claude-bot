import { existsSync } from "node:fs";
import type { LoopProjectConfig, LoopWorkspaceConfig } from "./config.js";
import type { LoopGitInvocation, LoopRunCommandInvocation, LoopRunCommandResult } from "./run.js";
import { parseSecurityRiskAssessment } from "./security-assessment.js";
import type { LoopDueTarget } from "./supervisor-dispatch-plan.js";
import {
  assessWorkspaceArchitecture,
  parseArchitectureAssessment,
} from "./workspace-assessment.js";

export type LoopPreDispatchAssessment = {
  score: number;
  targetScore: number;
  decision: "run";
  notes: string[];
};

export type LoopPreDispatchAssessmentDecision =
  | { decision: "run"; assessment?: LoopPreDispatchAssessment }
  | {
      decision: "skip" | "block";
      status: "completed" | "blocked";
      repairStatus: "not-needed" | "blocked";
      summary: string;
    };

export function resolveLoopPreDispatchAssessment(input: {
  target: LoopDueTarget;
  botRoot: string;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  exists?: (path: string) => boolean;
}): LoopPreDispatchAssessmentDecision {
  const { due, project, workspace } = input.target;
  if (workspace !== undefined && due.jobKind === "workspace-architecture") {
    const assessment = assessWorkspaceArchitecture({
      targetScore: workspace.architecture.targetScore,
      repositories: workspace.repositories,
      exists: input.exists ?? existsSync,
      runGit:
        input.runGit ?? (() => ({ status: 1, stdout: "", stderr: "git adapter unavailable" })),
    });
    if (assessment.decision === "skip") {
      return skipped(
        `workspace Architecture score ${assessment.score} reached target ${assessment.targetScore}; skipped before WorkOrder dispatch. ${assessment.notes.join("; ")}`,
      );
    }
    if (assessment.decision === "block" || assessment.score === null) {
      return blocked(
        `workspace Architecture pre-score blocked dispatch: ${assessment.blockers.join("; ") || "assessment failed"}`,
      );
    }
    return {
      decision: "run",
      assessment: {
        score: assessment.score,
        targetScore: assessment.targetScore,
        decision: "run",
        notes: assessment.notes,
      },
    };
  }

  if (workspace !== undefined && due.jobKind === "security-maintenance") {
    return workspaceSecurityDecision(workspace, input);
  }
  if (project !== undefined && due.jobKind === "architecture") {
    return projectArchitectureDecision(project, input);
  }
  if (project !== undefined && due.jobKind === "security-maintenance") {
    return projectSecurityDecision(project, input);
  }
  return { decision: "run" };
}

function projectArchitectureDecision(
  project: LoopProjectConfig,
  input: {
    target: LoopDueTarget;
    botRoot: string;
    runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  },
): LoopPreDispatchAssessmentDecision {
  const command = project.assessment.command;
  const assessment =
    command === undefined
      ? {
          score: null,
          targetScore: project.targetScore,
          decision: "block" as const,
          notes: [],
          blockers: ["project Architecture assessment command is not configured"],
        }
      : (() => {
          const commandResult = input.runCommand({
            kind: "assessment",
            command,
            cwd: project.path,
            env: {
              LOOP_PROJECT_ID: project.id,
              LOOP_PROJECT_NAME: project.name,
              LOOP_PROJECT_AGENT: project.agent,
              LOOP_PROJECT_GOAL: project.goal,
              LOOP_PROJECT_PATH: project.path,
              LOOP_BOT_ROOT: input.botRoot,
              LOOP_PROJECT_TARGET_SCORE: String(project.targetScore),
              LOOP_PROJECT_MAX_ROUNDS: String(project.maxRounds),
            },
          });
          return parseArchitectureAssessment(
            commandResult.status,
            commandResult.stdout,
            project.targetScore,
          );
        })();
  return architectureDecision("project", assessment);
}

function workspaceSecurityDecision(
  workspace: LoopWorkspaceConfig,
  input: {
    target: LoopDueTarget;
    botRoot: string;
    runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  },
): LoopPreDispatchAssessmentDecision {
  const policy = workspace.securityMaintenance.riskAssessment ?? {
    actionThreshold: 70,
    criticalThreshold: 90,
  };
  const command = policy.command;
  const assessment =
    command === undefined
      ? {
          riskScore: null,
          actionThreshold: policy.actionThreshold,
          criticalThreshold: policy.criticalThreshold,
          critical: false,
          decision: "block" as const,
          notes: [],
          blockers: ["security risk assessment command is not configured"],
        }
      : commandSecurityAssessment(
          input.runCommand,
          command,
          workspace.root,
          {
            LOOP_PROJECT_ID: workspace.id,
            LOOP_PROJECT_NAME: workspace.name,
            LOOP_PROJECT_AGENT: workspace.agent,
            LOOP_PROJECT_GOAL: workspace.securityMaintenance.prompt ?? "",
            LOOP_PROJECT_PATH: workspace.root,
            LOOP_BOT_ROOT: input.botRoot,
            LOOP_SECURITY_ACTION_THRESHOLD: String(policy.actionThreshold),
            LOOP_SECURITY_CRITICAL_THRESHOLD: String(policy.criticalThreshold),
          },
          policy.actionThreshold,
          policy.criticalThreshold,
        );
  return securityDecision("workspace", assessment);
}

function projectSecurityDecision(
  project: LoopProjectConfig,
  input: {
    target: LoopDueTarget;
    botRoot: string;
    runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  },
): LoopPreDispatchAssessmentDecision {
  const policy = project.securityMaintenance.riskAssessment ?? {
    actionThreshold: 70,
    criticalThreshold: 90,
  };
  const command = policy.command;
  const assessment =
    command === undefined
      ? {
          riskScore: null,
          actionThreshold: policy.actionThreshold,
          criticalThreshold: policy.criticalThreshold,
          critical: false,
          decision: "block" as const,
          notes: [],
          blockers: ["security risk assessment command is not configured"],
        }
      : commandSecurityAssessment(
          input.runCommand,
          command,
          project.path,
          {
            LOOP_PROJECT_ID: project.id,
            LOOP_PROJECT_NAME: project.name,
            LOOP_PROJECT_AGENT: project.agent,
            LOOP_PROJECT_GOAL: project.goal,
            LOOP_PROJECT_PATH: project.path,
            LOOP_BOT_ROOT: input.botRoot,
            LOOP_SECURITY_ACTION_THRESHOLD: String(policy.actionThreshold),
            LOOP_SECURITY_CRITICAL_THRESHOLD: String(policy.criticalThreshold),
          },
          policy.actionThreshold,
          policy.criticalThreshold,
        );
  return securityDecision("project", assessment);
}

function commandSecurityAssessment(
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult,
  command: string,
  cwd: string,
  env: Record<string, string>,
  actionThreshold: number,
  criticalThreshold: number,
): ReturnType<typeof parseSecurityRiskAssessment> {
  const commandResult = runCommand({ kind: "assessment", command, cwd, env });
  return parseSecurityRiskAssessment(
    commandResult.status,
    commandResult.stdout,
    actionThreshold,
    criticalThreshold,
  );
}

function architectureDecision(
  scope: "project" | "workspace",
  assessment: {
    score: number | null;
    targetScore: number;
    decision: "skip" | "run" | "block";
    notes: string[];
    blockers: string[];
  },
): LoopPreDispatchAssessmentDecision {
  const label = scope === "project" ? "project" : "workspace";
  if (assessment.decision === "skip") {
    return skipped(
      `${label} Architecture score ${assessment.score} reached target ${assessment.targetScore}; skipped before WorkOrder dispatch. ${assessment.notes.join("; ")}`,
    );
  }
  if (assessment.decision === "block") {
    return blocked(
      `${label} Architecture pre-score blocked dispatch: ${assessment.blockers.join("; ") || "assessment failed"}`,
    );
  }
  if (assessment.score === null) return { decision: "run" };
  return {
    decision: "run",
    assessment: {
      score: assessment.score,
      targetScore: assessment.targetScore,
      decision: "run",
      notes: assessment.notes,
    },
  };
}

function securityDecision(
  scope: "project" | "workspace",
  assessment: ReturnType<typeof parseSecurityRiskAssessment>,
): LoopPreDispatchAssessmentDecision {
  const label = scope === "project" ? "project" : "workspace";
  if (assessment.decision === "skip") {
    return skipped(
      `${label} Security Maintenance risk score ${assessment.riskScore} was below action threshold ${assessment.actionThreshold}; skipped before WorkOrder dispatch. ${assessment.notes.join("; ")}`,
    );
  }
  if (assessment.decision === "block" || assessment.riskScore === null) {
    return blocked(
      `${label} Security Maintenance pre-score blocked dispatch: ${assessment.blockers.join("; ") || "assessment failed"}`,
    );
  }
  return {
    decision: "run",
    assessment: {
      score: assessment.riskScore,
      targetScore: assessment.actionThreshold,
      decision: "run",
      notes: [
        `security action threshold=${assessment.actionThreshold}`,
        `critical threshold=${assessment.criticalThreshold}`,
        ...assessment.notes,
      ],
    },
  };
}

function skipped(summary: string): LoopPreDispatchAssessmentDecision {
  return { decision: "skip", status: "completed", repairStatus: "not-needed", summary };
}

function blocked(summary: string): LoopPreDispatchAssessmentDecision {
  return { decision: "block", status: "blocked", repairStatus: "blocked", summary };
}
