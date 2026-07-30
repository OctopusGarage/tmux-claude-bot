import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markImplementedOpportunitiesForCompletedDelegation } from "../../../src/core/opportunities/delegation-completion.js";
import { OpportunityStore } from "../../../src/core/opportunities/store.js";
import type { OpportunityDiscoveryReport } from "../../../src/core/opportunities/types.js";

describe("markImplementedOpportunitiesForCompletedDelegation", () => {
  it("marks explicit and run-linked opportunities implemented after a completed delegation", () => {
    const store = newStoreWithReport();
    const [first, second] = store.list().reverse();
    if (first === undefined || second === undefined) throw new Error("expected suggestions");
    store.updateStatus(second.id, "delegated", 111, { delegatedRunId: "run-1" });

    const updated = markImplementedOpportunitiesForCompletedDelegation({
      runId: "run-1",
      resultStatus: "completed",
      opportunityIds: [first.id],
      store,
      now: 222,
    });

    expect(updated.sort()).toEqual([first.id, second.id].sort());
    expect(store.get(first.id)).toMatchObject({
      status: "implemented",
      delegatedRunId: "run-1",
      updatedAt: 222,
    });
    expect(store.get(second.id)).toMatchObject({
      status: "implemented",
      delegatedRunId: "run-1",
      updatedAt: 222,
    });
  });

  it("does not mark opportunities implemented for failed delegations", () => {
    const store = newStoreWithReport();
    const [suggestion] = store.list();
    if (suggestion === undefined) throw new Error("expected suggestion");
    store.updateStatus(suggestion.id, "delegated", 111, { delegatedRunId: "run-1" });

    const updated = markImplementedOpportunitiesForCompletedDelegation({
      runId: "run-1",
      resultStatus: "failed",
      opportunityIds: [suggestion.id],
      store,
      now: 222,
    });

    expect(updated).toEqual([]);
    expect(store.get(suggestion.id)).toMatchObject({
      status: "delegated",
      delegatedRunId: "run-1",
      updatedAt: 111,
    });
  });
});

function newStoreWithReport(): OpportunityStore {
  const dir = mkdtempSync(join(tmpdir(), "tcb-opportunity-completion-"));
  const store = new OpportunityStore(join(dir, "index.json"));
  store.upsertDiscoveryReport({
    report,
    projectPath: "/repo/hub",
    runId: "discovery-1",
    cooldownDays: 14,
    now: Date.parse("2026-07-29T09:00:00Z"),
  });
  return store;
}

const report: OpportunityDiscoveryReport = {
  projectId: "hub",
  projectName: "Hub",
  generatedAt: "2026-07-29T09:00:00.000Z",
  coverage: "partial",
  checkedSignals: ["README", "scripts"],
  skippedSignals: [],
  suggestions: [
    {
      title: "Add a guided repair summary",
      category: "developer-experience",
      confidence: "high",
      problem: "Users must inspect several logs to understand repaired failures.",
      whyNow: "Task audit already records repair status.",
      value: "Reduces owner follow-up after scheduled tasks.",
      evidence: ["task ledger has repair status"],
      recommendedApproach: "Add a compact repair section to the audit notification.",
      alternatives: ["Link to raw logs only"],
      acceptanceCriteria: ["Audit message includes fixed/blocked repair counts"],
      risks: ["Notification may become too long"],
      nonGoals: ["Do not change repair logic"],
      estimatedComplexity: "small",
      delegateRequirement: "Add a compact repair section to the daily audit notification.",
    },
    {
      title: "Add dashboard smoke coverage",
      category: "testing",
      confidence: "medium",
      problem: "Dashboard regressions are only caught manually.",
      whyNow: "The dashboard route is now stable.",
      value: "Catches broken owner workflows before release.",
      evidence: ["dashboard route has no smoke test"],
      recommendedApproach: "Add one deterministic smoke test for the dashboard route.",
      alternatives: ["Manual QA only"],
      acceptanceCriteria: ["Smoke test covers dashboard load"],
      risks: ["Test setup may be slow"],
      nonGoals: ["Do not redesign the dashboard"],
      estimatedComplexity: "small",
      delegateRequirement: "Add one deterministic smoke test for the dashboard route.",
    },
  ],
};
