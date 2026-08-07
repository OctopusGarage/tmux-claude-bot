export type LoopWorkOrderPlanningSource =
  | "active-delegation"
  | "opportunity-delegation"
  | "task-family";

export type LoopWorkOrderPlanning = {
  required: boolean;
  source: LoopWorkOrderPlanningSource;
  requireOwnerConfirmation: boolean;
  rubric: string[];
  acceptanceCriteria: string[];
  stopConditions: string[];
  nonGoals: string[];
};

export type LoopSupervisorPlanReview = {
  checklistCompleted: boolean;
  targetScoreMet: boolean | "not-applicable";
  stopConditionReached: boolean;
  overOptimizationAvoided: boolean;
  verificationCompleted: boolean;
  remainingRisks: string[];
};

export function defaultActiveDelegationPlanning(): LoopWorkOrderPlanning {
  return {
    required: true,
    source: "active-delegation",
    requireOwnerConfirmation: false,
    rubric: [
      "The delegationBrief states the objective, current assessment, checklist, acceptance criteria, stop conditions, non-goals, risks, and verification plan before substantive execution.",
      "The implementation stays inside the confirmed requirement and avoids unrelated optimization or product scope.",
      "The final summary records planReview with checklist completion, target score applicability, stop condition status, over-optimization avoidance, verification, and remaining risks.",
    ],
    acceptanceCriteria: [
      "The requested behavior is implemented or a real blocker is proven with evidence.",
      "Relevant review, verification, and coverage or eval checks are completed or explicitly marked not applicable with evidence.",
      "The final report is sufficient to audit the work without reopening the full worker transcript.",
    ],
    stopConditions: [
      "The requirement is too broad, ambiguous, high-risk, or lacks clear acceptance criteria after inspection.",
      "Repository state, permissions, CI, or dependency issues prevent reliable verification.",
      "Continuing would require unrelated rewrites, unsupported direct model-provider integrations, or unsafe git operations.",
    ],
    nonGoals: [
      "Do not add unrelated features, broad rewrites, dependency churn, or cosmetic-only cleanups.",
      "Do not continue optimizing after the acceptance criteria and verification plan are satisfied.",
    ],
  };
}
