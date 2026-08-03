import type { OpportunityNotificationDigest, OpportunitySuggestion } from "./types.js";

const LIST_LIMIT = 10;

export function formatOpportunityDigest(digest: OpportunityNotificationDigest): string {
  const lines = [
    `Project: ${digest.projectName}`,
    `Suggestions: ${digest.suggestions.length}`,
    `Report: ${digest.reportPath}`,
    "",
  ];
  for (const [index, suggestion] of digest.suggestions.entries()) {
    lines.push(formatOpportunitySummary(suggestion, index + 1), "");
  }
  lines.push(
    "Commands:",
    "/opportunity list",
    "/opportunity show <number|id>",
    "/opportunity discuss <number|id>",
    "/opportunity dismiss <number|id>",
    "/opportunity snooze <number|id>",
    "After discussion: use Autopilot / Continue via supervisor for confirmed work",
  );
  return lines.join("\n").trimEnd();
}

export function formatOpportunityList(suggestions: OpportunitySuggestion[]): string {
  const visible = suggestions
    .filter(
      (suggestion) => suggestion.status !== "dismissed" && suggestion.status !== "implemented",
    )
    .slice(0, LIST_LIMIT);
  if (visible.length === 0) return "No active opportunity suggestions.";
  return visible
    .map((suggestion, index) => formatOpportunitySummary(suggestion, index + 1))
    .join("\n\n");
}

export function formatOpportunityDetail(suggestion: OpportunitySuggestion): string {
  return [
    formatOpportunitySummary(suggestion),
    "",
    "Problem:",
    suggestion.problem,
    "",
    "Why now:",
    suggestion.whyNow,
    "",
    "Value:",
    suggestion.value,
    "",
    "Evidence:",
    ...asBullets(suggestion.evidence),
    "",
    "Recommended approach:",
    suggestion.recommendedApproach,
    "",
    "Alternatives:",
    ...asBullets(suggestion.alternatives),
    "",
    "Acceptance criteria:",
    ...asBullets(suggestion.acceptanceCriteria),
    "",
    "Risks:",
    ...asBullets(suggestion.risks),
    "",
    "Non-goals:",
    ...asBullets(suggestion.nonGoals),
    "",
    "Next step:",
    "Discuss the scope first, then use Autopilot / Continue via supervisor for confirmed work.",
  ].join("\n");
}

export function formatOpportunityDiscussionPrompt(suggestion: OpportunitySuggestion): string {
  return [
    `Discussion opened for ${suggestion.id}: ${suggestion.title}`,
    "",
    "Decision points to clarify:",
    "- desired user-facing behavior",
    "- scope boundaries and non-goals",
    "- acceptable implementation risk",
    "- verification expectations",
    "",
    "When the scope is clear:",
    "Use Autopilot / Continue via supervisor for confirmed work.",
  ].join("\n");
}

export function formatOpportunityAgentDiscussionPrompt(suggestion: OpportunitySuggestion): string {
  return [
    `Discuss this proposed opportunity with the owner before any implementation: ${suggestion.id}`,
    "",
    `Title: ${suggestion.title}`,
    `Project: ${suggestion.projectName}`,
    `Category: ${suggestion.category}`,
    `Confidence: ${suggestion.confidence}`,
    `Estimated complexity: ${suggestion.estimatedComplexity}`,
    "",
    "Problem:",
    suggestion.problem,
    "",
    "Why now:",
    suggestion.whyNow,
    "",
    "Value:",
    suggestion.value,
    "",
    "Evidence:",
    ...asBullets(suggestion.evidence),
    "",
    "Recommended approach:",
    suggestion.recommendedApproach,
    "",
    "Acceptance criteria:",
    ...asBullets(suggestion.acceptanceCriteria),
    "",
    "Risks:",
    ...asBullets(suggestion.risks),
    "",
    "Non-goals:",
    ...asBullets(suggestion.nonGoals),
    "",
    "Instructions:",
    "- Do not implement yet.",
    "- Discuss scope, expected behavior, non-goals, risks, and verification with the owner.",
    "- Ask concise clarifying questions if needed.",
    "- When the owner confirms the scope, they can use Autopilot / Continue via supervisor to hand implementation to the Loop Supervisor.",
    "",
    "Delegation brief draft:",
    `objective: ${suggestion.delegateRequirement}`,
    "currentAssessment: proposed opportunity; confirm owner intent and inspect repository evidence before editing",
    "currentScore: not-applicable",
    "targetScore: not-applicable",
    "taskChecklist:",
    `- Confirm the accepted scope for ${suggestion.id}: ${suggestion.title}`,
    `- Implement the smallest coherent change: ${suggestion.recommendedApproach}`,
    "- Review the diff for regressions and scope creep",
    "acceptanceCriteria:",
    ...asBullets(suggestion.acceptanceCriteria),
    "stopConditions:",
    "- Owner does not confirm the scope or materially changes the objective",
    "- Repository evidence shows the opportunity is already solved or no longer relevant",
    "- Verification cannot be completed with reliable local or CI gates",
    "nonGoals:",
    ...asBullets(suggestion.nonGoals),
    "riskReview:",
    ...asBullets(suggestion.risks),
    "verificationPlan:",
    "- Run the relevant project tests, type/lint checks, smoke checks, or CI gates for the touched behavior",
    "- Record planReview before final completion",
    "",
    "Use this draft to form the Autopilot / Continue via supervisor delegationBrief; tighten it during discussion instead of expanding scope during execution.",
  ].join("\n");
}

export function formatOpportunityBatchAgentDiscussionPrompt(
  suggestions: OpportunitySuggestion[],
): string {
  const projectName = suggestions[0]?.projectName ?? "project";
  return [
    `Discuss these proposed opportunities for ${projectName} as one combined scope before any implementation.`,
    "",
    "Opportunities:",
    ...suggestions.flatMap((suggestion, index) => [
      "",
      `${index + 1}. ${suggestion.id}: ${suggestion.title}`,
      `Category: ${suggestion.category}`,
      `Confidence: ${suggestion.confidence}`,
      `Estimated complexity: ${suggestion.estimatedComplexity}`,
      `Problem: ${suggestion.problem}`,
      `Value: ${suggestion.value}`,
      "Recommended approach:",
      suggestion.recommendedApproach,
      "Acceptance criteria:",
      ...asBullets(suggestion.acceptanceCriteria),
      "Non-goals:",
      ...asBullets(suggestion.nonGoals),
      "Risks:",
      ...asBullets(suggestion.risks),
    ]),
    "",
    "Instructions:",
    "- Do not implement yet.",
    "- Discuss the opportunities together, identify overlap, sequencing, scope boundaries, non-goals, risks, and verification.",
    "- Recommend whether to implement all together, drop any item, or split only if there is a real engineering reason.",
    "- Ask concise clarifying questions if needed.",
    "- When the owner confirms the combined scope, they can use the Feishu card button to hand the combined implementation to the Loop Supervisor.",
    "",
    "Combined delegation brief draft:",
    `objective: Resolve the owner-confirmed subset of ${suggestions.length} proposed opportunit${suggestions.length === 1 ? "y" : "ies"} for ${projectName}.`,
    "currentAssessment: proposed opportunity batch; confirm overlap, sequencing, and repository evidence before editing",
    "currentScore: not-applicable",
    "targetScore: not-applicable",
    "taskChecklist:",
    ...suggestions.map(
      (suggestion) => `- Confirm and sequence ${suggestion.id}: ${suggestion.title}`,
    ),
    "- Implement only the accepted combined scope",
    "- Review the diff for regressions, duplicated work, and scope creep",
    "acceptanceCriteria:",
    ...asBullets(uniqueFlatMap(suggestions, (suggestion) => suggestion.acceptanceCriteria)),
    "stopConditions:",
    "- The opportunities do not share a coherent implementation path; split the work before delegation",
    "- Owner confirmation leaves material ambiguity about scope, sequencing, or verification",
    "- Verification cannot be completed with reliable local or CI gates",
    "nonGoals:",
    ...asBullets(uniqueFlatMap(suggestions, (suggestion) => suggestion.nonGoals)),
    "riskReview:",
    ...asBullets(uniqueFlatMap(suggestions, (suggestion) => suggestion.risks)),
    "verificationPlan:",
    "- Run the relevant project tests, type/lint checks, smoke checks, or CI gates for the touched behavior",
    "- Record planReview before final completion",
  ].join("\n");
}

function formatOpportunitySummary(suggestion: OpportunitySuggestion, ordinal?: number): string {
  const prefix = ordinal === undefined ? suggestion.id : `${ordinal}. ${suggestion.id}`;
  return [
    `${prefix} · ${suggestion.title}`,
    `Project: ${suggestion.projectName}`,
    `Category: ${suggestion.category} · Confidence: ${suggestion.confidence} · Complexity: ${suggestion.estimatedComplexity} · Status: ${suggestion.status}`,
    `Value: ${suggestion.value}`,
  ].join("\n");
}

function asBullets(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

function uniqueFlatMap(
  suggestions: OpportunitySuggestion[],
  select: (suggestion: OpportunitySuggestion) => string[],
): string[] {
  return [
    ...new Set(
      suggestions
        .flatMap(select)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
