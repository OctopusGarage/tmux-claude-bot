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
    "/opportunity delegate <number|id>",
    "/opportunity dismiss <number|id>",
    "/opportunity snooze <number|id>",
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
    "Delegate:",
    `/opportunity delegate ${suggestion.id}`,
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
    "When the scope is clear, use:",
    `/opportunity delegate ${suggestion.id}`,
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
    `- When the owner confirms the scope, they can use /opportunity delegate ${suggestion.id} or the Feishu card button to hand implementation to the Loop Supervisor.`,
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
  ].join("\n");
}

export function formatOpportunityBatchDelegateRequirement(
  suggestions: OpportunitySuggestion[],
): string {
  const projectName = suggestions[0]?.projectName ?? "project";
  return [
    `Implement the owner-approved opportunity batch for ${projectName}.`,
    "",
    "Scope:",
    ...suggestions.flatMap((suggestion, index) => [
      "",
      `${index + 1}. ${suggestion.id}: ${suggestion.title}`,
      "Requirement:",
      suggestion.delegateRequirement,
      "Acceptance criteria:",
      ...asBullets(suggestion.acceptanceCriteria),
      "Non-goals:",
      ...asBullets(suggestion.nonGoals),
      "Risks to check:",
      ...asBullets(suggestion.risks),
    ]),
    "",
    "Batch requirements:",
    "- Treat these opportunities as one coordinated implementation.",
    "- Reconfirm overlap and sequencing before editing.",
    "- Keep the change scoped to the approved opportunities; do not add unrelated product scope.",
    "- Complete implementation through review, relevant tests, coverage review for touched risk paths, and any justified existing deterministic or agent-backed eval.",
    "- Produce one coherent final summary and one PR when repository policy requires a PR.",
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
