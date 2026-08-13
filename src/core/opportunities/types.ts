export const OPPORTUNITY_CATEGORIES = [
  "product-feature",
  "workflow-automation",
  "developer-experience",
  "reliability",
  "architecture",
  "testing",
  "security",
] as const;

export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];
export type OpportunityConfidence = "low" | "medium" | "high";
export type OpportunityStatus =
  | "proposed"
  | "discussing"
  | "delegated"
  | "dismissed"
  | "snoozed"
  | "implemented";

export type OpportunitySuggestionInput = {
  title: string;
  category: OpportunityCategory;
  confidence: OpportunityConfidence;
  problem: string;
  whyNow: string;
  value: string;
  evidence: string[];
  recommendedApproach: string;
  alternatives: string[];
  acceptanceCriteria: string[];
  risks: string[];
  nonGoals: string[];
  estimatedComplexity: "small" | "medium" | "large";
  delegateRequirement: string;
};

export type OpportunitySuggestion = OpportunitySuggestionInput & {
  id: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  runId: string;
  discoveredAt: number;
  updatedAt: number;
  fingerprint: string;
  status: OpportunityStatus;
  snoozedUntil?: number;
  delegatedRunId?: string;
};

export type OpportunityDiscoveryReport = {
  projectId: string;
  projectName: string;
  generatedAt: string;
  coverage: "complete" | "partial" | "unknown";
  checkedSignals: string[];
  skippedSignals: string[];
  suggestions: OpportunitySuggestionInput[];
};

export type OpportunityNotificationDigest = {
  projectId: string;
  projectName: string;
  suggestions: OpportunitySuggestion[];
  reportPath: string;
};

/** Whether a suggestion belongs in the current actionable list. */
export function isOpportunityVisible(suggestion: OpportunitySuggestion, now: number): boolean {
  if (suggestion.status === "dismissed" || suggestion.status === "implemented") return false;
  if (suggestion.status !== "snoozed") return true;
  return suggestion.snoozedUntil !== undefined && suggestion.snoozedUntil <= now;
}
