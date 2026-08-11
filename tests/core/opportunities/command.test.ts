import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { runOpportunityCommand } from "../../../src/core/opportunities/command.js";
import { OpportunityStore } from "../../../src/core/opportunities/store.js";
import type { OpportunityDiscoveryReport } from "../../../src/core/opportunities/types.js";

const oldStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  vi.useRealTimers();
  if (oldStateDir === undefined) {
    delete process.env.TCB_STATE_DIR;
  } else {
    process.env.TCB_STATE_DIR = oldStateDir;
  }
});

describe("runOpportunityCommand", () => {
  it("lists, shows, discusses, and dismisses stored opportunity suggestions", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-opportunity-command-"));
    const store = new OpportunityStore();
    const [suggestion] = store.upsertDiscoveryReport({
      report,
      projectPath: "/repo/hub",
      runId: "run-1",
      cooldownDays: 14,
      now: Date.parse("2026-07-29T09:00:00Z"),
    });
    if (suggestion === undefined) throw new Error("expected suggestion");

    const list = await runOpportunityCommand({} as HandlerDeps, "telegram", "list");
    const showByNumber = await runOpportunityCommand({} as HandlerDeps, "telegram", "show 1");
    const show = await runOpportunityCommand(
      {} as HandlerDeps,
      "telegram",
      `show ${suggestion.id}`,
    );
    const discuss = await runOpportunityCommand(
      {} as HandlerDeps,
      "telegram",
      `discuss ${suggestion.id}`,
    );
    const dismiss = await runOpportunityCommand(
      {} as HandlerDeps,
      "telegram",
      `dismiss ${suggestion.id}`,
    );

    expect(list.body).toContain("Add a guided repair summary");
    expect(list.body).toContain(`1. ${suggestion.id}`);
    expect(showByNumber.body).toContain("Acceptance criteria:");
    expect(show.body).toContain("Acceptance criteria:");
    expect(discuss.body).toContain("Use Autopilot / Continue via supervisor");
    expect(dismiss).toMatchObject({ tone: "ok" });
    expect(new OpportunityStore().get(suggestion.id)).toMatchObject({ status: "dismissed" });
  });

  it("hides snoozed suggestions until their durable deadline expires", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-29T09:00:00Z");
    vi.setSystemTime(now);
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-opportunity-command-"));
    const [suggestion] = new OpportunityStore().upsertDiscoveryReport({
      report,
      projectPath: "/repo/hub",
      runId: "run-1",
      cooldownDays: 14,
      now,
    });
    if (suggestion === undefined) throw new Error("expected suggestion");

    await runOpportunityCommand({} as HandlerDeps, "telegram", `snooze ${suggestion.id}`);

    expect((await runOpportunityCommand({} as HandlerDeps, "telegram", "list")).body).toBe(
      "No active opportunity suggestions.",
    );
    expect((await runOpportunityCommand({} as HandlerDeps, "telegram", "show 1")).body).toContain(
      "Opportunity not found",
    );

    vi.setSystemTime(now + 14 * 24 * 60 * 60 * 1000);
    expect((await runOpportunityCommand({} as HandlerDeps, "telegram", "list")).body).toContain(
      suggestion.title,
    );
  });

  it("returns usage errors for missing ids", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-opportunity-command-"));

    const result = await runOpportunityCommand({} as HandlerDeps, "telegram", "show");

    expect(result).toMatchObject({
      tone: "err",
      body: "Usage: /opportunity list|show|discuss|dismiss|snooze <number|id>. Use Autopilot after discussion to delegate confirmed work.",
    });
  });

  it("does not support direct opportunity delegation", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-opportunity-command-"));
    const [suggestion] = new OpportunityStore().upsertDiscoveryReport({
      report,
      projectPath: "/repo/hub",
      runId: "run-1",
      cooldownDays: 14,
      now: Date.parse("2026-07-29T09:00:00Z"),
    });
    if (suggestion === undefined) throw new Error("expected suggestion");

    const result = await runOpportunityCommand(
      {} as HandlerDeps,
      "telegram",
      `delegate ${suggestion.id}`,
    );

    expect(result).toMatchObject({ tone: "err" });
    expect(result.body).toContain("/opportunity list|show|discuss|dismiss|snooze");
  });

  it("reports a useful error for unknown numeric references", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-opportunity-command-"));

    const result = await runOpportunityCommand({} as HandlerDeps, "telegram", "show 99");

    expect(result).toMatchObject({ tone: "err" });
    expect(result.body).toContain("Use /opportunity list");
  });
});

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
