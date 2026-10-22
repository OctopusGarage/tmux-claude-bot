import { describe, expect, it } from "vitest";
import type { OpportunitySuggestion } from "../../../src/core/opportunities/types.js";
import {
  formatOpportunityAgentDiscussionPrompt,
  formatOpportunityBatchAgentDiscussionPrompt,
} from "../../../src/core/opportunities/view.js";

describe("opportunity discussion prompts", () => {
  it("turns a single opportunity into a delegation brief draft", () => {
    const prompt = formatOpportunityAgentDiscussionPrompt(suggestion("opp-1", "Improve logs"));

    expect(prompt).toContain("Delegation brief draft:");
    expect(prompt).toContain("objective:");
    expect(prompt).toContain("taskChecklist:");
    expect(prompt).toContain("acceptanceCriteria:");
    expect(prompt).toContain("stopConditions:");
    expect(prompt).toContain("nonGoals:");
    expect(prompt).toContain("riskReview:");
    expect(prompt).toContain("verificationPlan:");
    expect(prompt).toContain("Use this draft to form the Autopilot / Continue via supervisor");
  });

  it("asks batch discussions to produce one bounded delegation brief", () => {
    const prompt = formatOpportunityBatchAgentDiscussionPrompt([
      suggestion("opp-1", "Improve logs"),
      suggestion("opp-2", "Add smoke test"),
    ]);

    expect(prompt).toContain("Combined delegation brief draft:");
    expect(prompt).toContain("objective:");
    expect(prompt).toContain("taskChecklist:");
    expect(prompt).toContain("acceptanceCriteria:");
    expect(prompt).toContain("stopConditions:");
    expect(prompt).toContain("nonGoals:");
    expect(prompt).toContain("riskReview:");
    expect(prompt).toContain("verificationPlan:");
    expect(prompt).toContain("split the work before delegation");
  });
});

function suggestion(id: string, title: string): OpportunitySuggestion {
  return {
    id,
    title,
    category: "developer-experience",
    confidence: "high",
    problem: "Users need to inspect several logs manually.",
    whyNow: "The repeated task flow already has structured reports.",
    value: "Reduces follow-up and improves auditability.",
    evidence: ["loop reports exist", "current logs are noisy"],
    recommendedApproach: "Add a concise current-run summary.",
    alternatives: ["Link only to raw logs"],
    acceptanceCriteria: ["Current-run logs are easy to locate"],
    risks: ["Report can become noisy"],
    nonGoals: ["Do not change task execution logic"],
    estimatedComplexity: "small",
    delegateRequirement: "Add a concise current-run summary.",
    projectId: "hub",
    projectName: "Hub",
    projectPath: "/repo/hub",
    runId: "run-1",
    discoveredAt: 1,
    updatedAt: 1,
    fingerprint: id,
    status: "proposed",
  };
}
