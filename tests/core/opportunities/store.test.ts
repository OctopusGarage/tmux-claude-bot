import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OpportunityStore,
  parseOpportunityDiscoveryReportFile,
} from "../../../src/core/opportunities/store.js";
import type { OpportunityDiscoveryReport } from "../../../src/core/opportunities/types.js";

const report: OpportunityDiscoveryReport = {
  projectId: "hub",
  projectName: "Hub",
  generatedAt: "2026-07-29T09:00:00.000Z",
  coverage: "partial",
  checkedSignals: ["README", "scripts", "recent loop failures"],
  skippedSignals: [],
  suggestions: [
    {
      title: "Add a guided repair summary",
      category: "developer-experience",
      confidence: "high",
      problem: "Users must inspect several logs to understand repaired failures.",
      whyNow: "Task audit already records repair status.",
      value: "Reduces owner follow-up after scheduled tasks.",
      evidence: ["task ledger has repair status", "daily audit sends summary"],
      recommendedApproach: "Add a compact repair section to the audit notification.",
      alternatives: ["Link to raw logs only"],
      acceptanceCriteria: ["Audit message includes fixed/blocked repair counts"],
      risks: ["Notification may become too long"],
      nonGoals: ["Do not change repair logic"],
      estimatedComplexity: "small",
      delegateRequirement: "Add a compact repair section to the daily audit notification.",
    },
  ],
};

describe("OpportunityStore", () => {
  it("stores new suggestions and suppresses duplicates within cooldown", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-opportunities-"));
    const store = new OpportunityStore(join(dir, "index.json"));

    const first = store.upsertDiscoveryReport({
      report,
      projectPath: "/repo/hub",
      runId: "run-1",
      cooldownDays: 14,
      now: Date.parse("2026-07-29T09:00:00Z"),
    });
    const second = store.upsertDiscoveryReport({
      report,
      projectPath: "/repo/hub",
      runId: "run-2",
      cooldownDays: 14,
      now: Date.parse("2026-07-30T09:00:00Z"),
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      projectId: "hub",
      projectPath: "/repo/hub",
      status: "proposed",
      title: "Add a guided repair summary",
    });
  });

  it("updates suggestion status for owner decisions", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-opportunities-"));
    const store = new OpportunityStore(join(dir, "index.json"));
    const [suggestion] = store.upsertDiscoveryReport({
      report,
      projectPath: "/repo/hub",
      runId: "run-1",
      cooldownDays: 14,
      now: Date.parse("2026-07-29T09:00:00Z"),
    });

    const updated = store.updateStatus(suggestion?.id ?? "", "delegated", 123, {
      delegatedRunId: "delegate-run",
    });

    expect(updated).toMatchObject({
      status: "delegated",
      delegatedRunId: "delegate-run",
      updatedAt: 123,
    });
  });

  it("parses valid report files and rejects malformed reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-opportunity-report-"));
    const valid = join(dir, "valid.json");
    const invalid = join(dir, "invalid.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(valid, JSON.stringify(report));
    writeFileSync(
      invalid,
      JSON.stringify({ ...report, suggestions: [{ title: "missing fields" }] }),
    );

    expect(parseOpportunityDiscoveryReportFile(valid)).toMatchObject({
      projectId: "hub",
      suggestions: [expect.objectContaining({ title: "Add a guided repair summary" })],
    });
    expect(parseOpportunityDiscoveryReportFile(invalid)).toBeNull();
  });
});
