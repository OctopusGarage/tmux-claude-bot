import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverLoopEngineeringScheduledTasks,
  mergeDiscoveredTaskRecords,
} from "../../src/core/tasks/task-discovery.js";
import { singaporeDayWindow } from "../../src/core/tasks/task-ledger.js";

const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
const reviewGate = {
  preMutationReview: [],
  postMutationReview: [],
  aiReview: "passed",
  deterministicGates: [],
  decision: "pass",
  notes: [],
};
function fixture(status = "in-flight") {
  const root = mkdtempSync(join(tmpdir(), "tcb-discovery-acceptance-"));
  const runId = `${scheduledAt}-suite`;
  const runDir = join(root, "loop-runs", "suite", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "supervisor-final-summary.json"),
    JSON.stringify({
      status: "completed",
      projectId: "suite",
      finalVerification: "passed",
      actionsTaken: ["Worker finished; system acceptance pending"],
      reviewGate,
    }),
  );
  writeFileSync(
    join(runDir, "work-order-state.json"),
    JSON.stringify({
      status,
      runId,
      projectId: "suite",
      scheduledAt,
      updatedAt: scheduledAt + 1000,
      supervisorSession: "supervisor",
    }),
  );
  const record = {
    taskId: `loop:suite:${scheduledAt}`,
    source: "loop-engineering" as const,
    name: "suite architecture",
    scheduledAt,
    status: "running" as const,
    repairStatus: "running" as const,
    updatedAt: scheduledAt + 1000,
    reportPath: join(runDir, "supervisor.md"),
  };
  return { root, runDir, runId, record };
}

describe("scheduled task discovery acceptance", () => {
  it.each(["dispatching", "queued", "in-flight", "needs-revision"])(
    "keeps %s summary evidence running before system acceptance",
    (status) => {
      const { record } = fixture(status);
      expect(mergeDiscoveredTaskRecords([record], [])[0]).toMatchObject({
        status: "running",
        repairStatus: "running",
      });
    },
  );

  it("discovers the live occurrence as running before acceptance", () => {
    const { root, runDir } = fixture();
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `projects:
  - id: suite
    name: Suite
    path: /tmp/synthetic-suite
    agent: codex
    schedule: "0 1 * * *"
    goal: Check health
    maxRounds: 1
    targetScore: 95
    assessment:
      command: "true"
    allowedActions: []
    blockedActions: []
`,
    );
    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir: join(root, "loop-runs"),
      window: singaporeDayWindow("2026-07-27"),
      now: scheduledAt + 3_600_000,
    });
    expect(records).toEqual([
      expect.objectContaining({
        status: "running",
        repairStatus: "running",
        reportPath: join(runDir, "supervisor-final-summary.json"),
      }),
    ]);
  });

  it.each(["runId", "projectId", "scheduledAt"])(
    "does not bind unrelated %s state to a legacy summary",
    (field) => {
      const { record, runDir, runId } = fixture();
      writeFileSync(
        join(runDir, "work-order-state.json"),
        JSON.stringify({
          status: "in-flight",
          runId,
          projectId: "suite",
          scheduledAt,
          [field]: field === "scheduledAt" ? scheduledAt - 1 : "foreign",
        }),
      );
      expect(mergeDiscoveredTaskRecords([record], [])[0]).toMatchObject({
        status: "success",
        repairStatus: "not-needed",
      });
    },
  );

  it("retains explicit system rejection over live summary evidence", () => {
    const { record, runDir } = fixture();
    writeFileSync(
      join(runDir, "system-gate.json"),
      JSON.stringify({ accepted: false, failures: ["Required CI failed"] }),
    );
    expect(mergeDiscoveredTaskRecords([record], [])[0]).toMatchObject({
      status: "failed",
      repairStatus: "pending",
      error: "supervised system gate failed: Required CI failed",
    });
  });

  it("accepts a matching completed system gate during the state publication gap", () => {
    const { record, runDir, runId } = fixture();
    writeFileSync(
      join(runDir, "system-gate.json"),
      JSON.stringify({
        workOrderId: runId,
        projectId: "suite",
        accepted: true,
        resultStatus: "completed",
        failures: [],
        supervisorReviewGate: reviewGate,
      }),
    );
    expect(mergeDiscoveredTaskRecords([record], [])[0]).toMatchObject({
      status: "success",
      repairStatus: "not-needed",
    });
  });

  it("does not accept a foreign gate for a live summary", () => {
    const { record, runDir } = fixture();
    writeFileSync(
      join(runDir, "system-gate.json"),
      JSON.stringify({
        workOrderId: "foreign",
        projectId: "suite",
        accepted: true,
        resultStatus: "completed",
        failures: [],
        supervisorReviewGate: reviewGate,
      }),
    );
    expect(mergeDiscoveredTaskRecords([record], [])[0]).toMatchObject({
      status: "running",
      repairStatus: "running",
    });
  });

  it.each(["live", "rejected", "failed-verification", "summary-only", "malformed-final"])(
    "does not let a %s later summary close an older failure",
    (variant) => {
      const { root, runDir } = fixture(variant === "live" ? "in-flight" : "failed");
      if (variant === "rejected")
        writeFileSync(
          join(runDir, "system-gate.json"),
          JSON.stringify({ accepted: false, failures: ["CI failed"] }),
        );
      if (variant === "failed-verification")
        writeFileSync(
          join(runDir, "supervisor-final-summary.json"),
          JSON.stringify({ status: "completed", finalVerification: "failed" }),
        );
      if (variant === "summary-only") {
        rmSync(join(runDir, "supervisor-final-summary.json"));
        writeFileSync(
          join(runDir, "supervisor-summary.json"),
          JSON.stringify({ status: "completed" }),
        );
      }
      if (variant === "malformed-final") {
        writeFileSync(join(runDir, "supervisor-final-summary.json"), "{");
        writeFileSync(
          join(runDir, "supervisor-summary.json"),
          JSON.stringify({ status: "completed" }),
        );
      }
      const previousAt = scheduledAt - 86400000;
      const previous = join(root, "loop-runs", "suite", `${previousAt}-suite`);
      mkdirSync(previous, { recursive: true });
      writeFileSync(
        join(previous, "supervisor-final-summary.json"),
        JSON.stringify({ status: "failed" }),
      );
      const configFile = join(root, "loop.yml");
      writeFileSync(
        configFile,
        `projects:
  - id: suite
    name: Suite
    path: /tmp/synthetic-suite
    agent: codex
    schedule: "0 1 * * *"
    goal: Check health
    maxRounds: 1
    targetScore: 95
    assessment:
      command: "true"
    allowedActions: []
    blockedActions: []
`,
      );
      const records = discoverLoopEngineeringScheduledTasks({
        configFile,
        loopRunsDir: join(root, "loop-runs"),
        window: singaporeDayWindow("2026-07-26"),
        now: scheduledAt + 3_600_000,
      });
      expect(records.find((r) => r.scheduledAt === previousAt)).toMatchObject({
        status: "failed",
        repairStatus: "pending",
      });
    },
  );
});
