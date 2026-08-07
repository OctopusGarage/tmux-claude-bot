import type { LoopTaskSchedulerJobKind } from "../loop/task-family.js";

export type PromptRiskLevel = "low" | "medium" | "high";

export type PromptActionScope = "read-only" | "code-change" | "commit" | "pr-create" | "auto-merge";

export type PromptAudience = "active-agent" | "operator-agent";

export type PromptEvalExpectation =
  | "docs-only"
  | "contract-test"
  | "active-agent-eval"
  | "workorder-smoke";

export type GovernedPromptId =
  | "loop.supervisor.main"
  | "loop.supervisor.finalization"
  | "loop.supervisor.revision"
  | "loop.policy.architecture"
  | "loop.policy.workspace-architecture"
  | "loop.policy.bug-fix"
  | "loop.policy.test-coverage"
  | "loop.policy.security-maintenance"
  | "loop.policy.harness-auto"
  | "loop.policy.opportunity-discovery"
  | "loop.policy.automation-governance-review"
  | "loop.policy.pull-request-review"
  | "loop.policy.repository-pull-request-review"
  | "loop.policy.repository-pull-request-repair"
  | "loop.policy.active-delegated-task"
  | "repair.daily-task-audit"
  | "repair.runtime-guardian"
  | "legacy.loop.agent-eval"
  | "legacy.loop.agent-task"
  | "legacy.loop.preflight-repair"
  | "legacy.loop.dirty-worktree-recovery"
  | "legacy.loop.verification-recovery"
  | "legacy.loop.post-commit-dirty-recovery"
  | "opportunity.discussion.single"
  | "opportunity.discussion.batch"
  | "workflow.audit.finder"
  | "workflow.audit.verifier"
  | "workflow.arch-loop";

export type PromptSpec = {
  id: GovernedPromptId;
  version: number;
  owner: string;
  audience: PromptAudience;
  riskLevel: PromptRiskLevel;
  actionScope: PromptActionScope;
  evalExpectation: PromptEvalExpectation;
  taskKinds?: readonly LoopTaskSchedulerJobKind[];
  legacy?: boolean;
  description: string;
};
