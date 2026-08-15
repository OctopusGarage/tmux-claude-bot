import type { NotificationChannelSelection } from "../notifications/gateway.js";
import type { ApprovedSkill } from "../skills/schema.js";
import type { LoopProjectConfig } from "./config.js";
import type { LoopSupervisorPlanReview, LoopWorkOrderPlanning } from "./planning.js";

export type SupervisorFinalStatus = "completed" | "failed" | "blocked" | "timeout" | "cancelled";

export type LoopSupervisorPullRequestDecisionOutcome =
  | "merged"
  | "closed"
  | "approved"
  | "retry"
  | "manual-review";

export type LoopSupervisorPullRequestCloseReason =
  | "duplicate"
  | "obsolete"
  | "non-actionable"
  | "invalid";

export type LoopSupervisorPullRequestHumanBoundary =
  | "ownership"
  | "protected-branch-policy"
  | "product-decision"
  | "migration-decision"
  | "security-decision"
  | "legal-compliance"
  | "organization-policy";

export type LoopSupervisorPullRequestDecision = {
  number: number;
  repository: string;
  outcome: LoopSupervisorPullRequestDecisionOutcome;
  boundary?: LoopSupervisorPullRequestHumanBoundary;
  reason?: LoopSupervisorPullRequestCloseReason;
  reviewedHeadSha?: string;
  evidence: string[];
  nextStep: string;
};

export type LoopSupervisorFinalSummary = {
  status: SupervisorFinalStatus;
  projectId: string;
  actionsTaken: string[];
  delegatedTasks: Array<{ projectId: string; status: string } | string>;
  finalVerification: "passed" | "failed" | "not-run" | "unknown";
  pullRequestDecisions?: LoopSupervisorPullRequestDecision[];
  reviewGate?: LoopSupervisorReviewGate;
  planReview?: LoopSupervisorPlanReview;
  learning?: LoopSupervisorLearning;
  commits: string[];
  followUps: string[];
};

export type LoopSupervisorReviewGate = {
  preMutationReview: string[];
  postMutationReview: string[];
  aiReview: "passed" | "failed" | "not-run" | "not-applicable";
  deterministicGates: LoopSupervisorReviewGateDeterministicGate[];
  decision: "pass" | "block" | "fail";
  notes: string[];
  evidence?: LoopSupervisorReviewEvidence[];
};

export type LoopSupervisorReviewEvidence = {
  questionInvestigated: string;
  conclusion: string;
  evidence: string[];
  uncertainty: string;
  recommendedNextStep: string;
};

export type LoopSupervisorLearning = {
  regressionCandidates: string[];
  capabilityEvalCandidates: string[];
  monitorOrTraceCandidates: string[];
  documentationCandidates: string[];
};

export type LoopSupervisorReviewGateDeterministicGateObject = {
  name: string;
  command?: string;
  result: "passed" | "failed" | "skipped" | "not-run";
  evidence?: string;
};

export type LoopSupervisorReviewGateDeterministicGate =
  | string
  | LoopSupervisorReviewGateDeterministicGateObject;

export type LoopExecutionIsolation = {
  mode: "supervised-worker";
  expectedWorktree: string;
  sourceWorktree?: string;
  worktreeIsolation: "isolated" | "source" | "auto";
  preparedBy?: "system-git-worktree" | "source-worktree";
  contextReset: "compact" | "clear";
  cleanup: {
    success: "release-worker";
    failure: "retain-for-ttl";
    retainFailureForHours: number;
  };
};

export type LoopWorktreeIsolationMode = LoopExecutionIsolation["worktreeIsolation"];

export type LoopCleanupPolicy = "conservative" | "balanced" | "aggressive";

export type HarnessAutoSubtaskKind =
  | "architecture"
  | "bug-fix"
  | "test-coverage"
  | "security-maintenance";

export type HarnessAutoSubtask =
  | {
      kind: "architecture";
      enabled: boolean;
      weight: number;
      targetScore: number;
      maxRounds: number;
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    }
  | {
      kind: "bug-fix";
      enabled: boolean;
      weight: number;
      maxRounds: number;
      maxBugsPerRound: number;
      requireRegressionTest: boolean;
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    }
  | {
      kind: "test-coverage";
      enabled: boolean;
      weight: number;
      targetCoverage: number;
      maxRounds: number;
      requireMeaningfulTests: boolean;
      allowIntegrationTests: boolean;
      allowSmokeTests: boolean;
      allowE2ETests: boolean;
      allowAiEvalTests: boolean;
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    }
  | {
      kind: "security-maintenance";
      enabled: boolean;
      weight: number;
      maxRounds: number;
      actionThreshold: number;
      criticalThreshold: number;
      allowDependencyUpdates: boolean;
      allowConfigHardening: boolean;
      allowStaticAnalysisFixes: boolean;
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    };

export type LoopWorkOrderTask =
  | { kind: "architecture" }
  | {
      kind: "workspace-architecture";
      prompt?: string;
    }
  | {
      kind: "bug-fix";
      maxRounds: number;
      maxBugsPerRound: number;
      requireRegressionTest: boolean;
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    }
  | {
      kind: "test-coverage";
      targetCoverage: number;
      maxRounds: number;
      requireMeaningfulTests: boolean;
      allowIntegrationTests: boolean;
      allowSmokeTests: boolean;
      allowE2ETests: boolean;
      allowAiEvalTests: boolean;
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    }
  | {
      kind: "security-maintenance";
      maxRounds: number;
      actionThreshold: number;
      criticalThreshold: number;
      allowDependencyUpdates: boolean;
      allowConfigHardening: boolean;
      allowStaticAnalysisFixes: boolean;
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    }
  | {
      kind: "harness-auto";
      maxRounds: number;
      strategy: "health-first" | "risk-first" | "configured-order";
      stopWhen: {
        healthScoreAtLeast: number;
        noConfirmedIssues: boolean;
      };
      tasks: HarnessAutoSubtask[];
      cleanupPolicy?: LoopCleanupPolicy;
      prompt?: string;
    }
  | {
      kind: "opportunity-discovery";
      maxRounds: number;
      maxSuggestions: number;
      minConfidence: "low" | "medium" | "high";
      categories: string[];
      cooldownDays: number;
      requireEvidence: boolean;
      notificationChannel?: NotificationChannelSelection;
      prompt?: string;
    }
  | {
      kind: "automation-governance-review";
      targetScore: number;
      maxFindings: number;
      allowRepairPr: boolean;
      requireAiEval: boolean;
      prompt?: string;
    }
  | {
      kind: "pull-request-review";
      lookbackHours: number;
      consecutivePasses: number;
      autoMerge: boolean;
      mergeMethod: "squash" | "merge" | "rebase";
      prompt?: string;
    }
  | {
      kind: "repository-pull-request-review";
      repo: string;
      base?: string;
      lookbackHours: number;
      consecutivePasses: number;
      autoMerge: boolean;
      mergeMethod: "squash" | "merge" | "rebase";
      repair: {
        enabled: boolean;
        maxAttempts: number;
        prompt?: string;
      };
      prompt?: string;
    }
  | {
      kind: "active-delegated-task";
      sourceSession: string;
      requirement: string;
      requireReview: boolean;
      requireTests: boolean;
      requireCoverageReview: boolean;
      allowAiEval: boolean;
    };

export type LoopWorkspaceRepository = {
  id: string;
  name: string;
  path: string;
  sourcePath?: string;
  worktreeIsolation?: LoopWorktreeIsolationMode;
  role: string;
  agent: LoopProjectConfig["agent"];
  pullRequest: LoopProjectConfig["pullRequest"];
  workerSession?: string;
};

export type LoopWorkOrder = {
  id: string;
  scheduledAt: number;
  task?: LoopWorkOrderTask;
  projectId: string;
  projectName: string;
  projectPath: string;
  executionIsolation?: LoopExecutionIsolation;
  cleanupPolicy?: LoopCleanupPolicy;
  planning?: LoopWorkOrderPlanning;
  relatedOpportunityIds?: string[];
  notificationSession?: string;
  notificationMode?: "interactive" | "autonomous";
  workerSession?: string;
  agent: LoopProjectConfig["agent"];
  goal: string;
  maxRounds: number;
  targetScore: number;
  runner: LoopProjectConfig["runner"];
  allowedActions: string[];
  blockedActions: string[];
  skills: { approved: ApprovedSkill[] };
  preflight: LoopProjectConfig["preflight"];
  assessment: LoopProjectConfig["assessment"];
  preDispatchAssessment?: {
    score: number;
    targetScore: number;
    decision: "run";
    notes: string[];
  };
  eval?: LoopProjectConfig["eval"];
  execution: LoopProjectConfig["execution"];
  recovery: LoopProjectConfig["recovery"];
  commitPolicy: LoopProjectConfig["commit"];
  pullRequestPolicy?: LoopProjectConfig["pullRequest"];
  governance?: {
    scope: "bot-self-maintenance";
    targetScore: number;
    maxFindings: number;
    requireAiEval: boolean;
    repair: {
      allowPullRequest: boolean;
      autoMerge: false;
      minimumSeverity: "P1";
      maxPullRequests: 1;
    };
  };
  workspace?: {
    root: string;
    repositories: LoopWorkspaceRepository[];
  };
  requiredFinalMarker: string;
  finalSummaryPath?: string;
  opportunityReportPath?: string;
};

export type ParseSupervisorFinalSummaryResult =
  | { ok: true; summary: LoopSupervisorFinalSummary }
  | { ok: false; reason: "missing-final-marker" | "invalid-summary" };
