import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOP_RUN_ARTIFACTS, loopRunArtifactPath } from "../../src/core/loop/artifacts.js";
import {
  listLoopReportRecords,
  queryLoopReportRecords,
} from "../../src/core/loop/report-catalog.js";

describe("listLoopReportRecords", () => {
  it("ignores non-directory entries in the loop-runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcb-loop-report-catalog-"));
    writeFileSync(join(root, ".metadata_never_index"), "");

    expect(listLoopReportRecords(root)).toEqual([]);
  });

  it("projects command and supervisor report files into one report record list", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcb-loop-report-catalog-"));
    const commandDir = join(root, "hub", "run-command");
    const supervisorDir = join(root, "hub", "run-supervisor");
    mkdirSync(commandDir, { recursive: true });
    mkdirSync(supervisorDir, { recursive: true });
    writeFileSync(
      join(commandDir, LOOP_RUN_ARTIFACTS.commandSummary),
      `${JSON.stringify({
        record: {
          runId: "run-command",
          projectId: "hub",
          projectName: "Hub",
          status: "passed",
          startedAt: 1_000,
          endedAt: 2_000,
          markdownPath: join(commandDir, "report.md"),
          summaryPath: join(commandDir, LOOP_RUN_ARTIFACTS.commandSummary),
        },
      })}\n`,
    );
    writeFileSync(
      join(supervisorDir, LOOP_RUN_ARTIFACTS.supervisorSummary),
      `${JSON.stringify({
        runId: "run-supervisor",
        project: { id: "hub", name: "Hub" },
        status: "completed",
        timestamps: { startedAt: 3_000, endedAt: 4_000 },
        evalReportPath: join(supervisorDir, LOOP_RUN_ARTIFACTS.evalReport),
      })}\n`,
    );
    writeFileSync(
      join(supervisorDir, LOOP_RUN_ARTIFACTS.evalReport),
      `${JSON.stringify({
        schemaVersion: 1,
        source: {
          kind: "work-order-final-summary",
          workOrderId: "run-supervisor",
          projectId: "hub",
        },
        executionBoundary: "worker-internal",
        outcome: { status: "passed", finalVerification: "passed" },
        evidence: [],
        deterministicGates: [],
        notes: [],
        learningCandidates: {
          regression: [],
          capability: [],
          monitorOrTrace: [],
          documentation: [],
        },
      })}\n`,
    );

    const records = listLoopReportRecords(root);
    expect(records).toEqual([
      expect.objectContaining({
        runId: "run-supervisor",
        status: "passed",
        evalReportPath: join(supervisorDir, LOOP_RUN_ARTIFACTS.evalReport),
        evalOutcome: {
          status: "passed",
          finalVerification: "passed",
        },
      }),
      expect.objectContaining({
        runId: "run-command",
        status: "passed",
      }),
    ]);
    expect(records[1]?.evalReportPath).toBeUndefined();

    expect(queryLoopReportRecords(root, { projectId: "hub", status: "passed", limit: 1 })).toEqual({
      items: [expect.objectContaining({ runId: "run-supervisor" })],
      total: 2,
      limit: 1,
      truncated: true,
    });
  });

  it("builds canonical loop run artifact paths", () => {
    expect(loopRunArtifactPath("hub", "run-1", "systemGate", "/state")).toBe(
      join("/state", "loop-runs", "hub", "run-1", "system-gate.json"),
    );
    expect(loopRunArtifactPath("hub", "run-1", "supervisorFinalSummary", "/state")).toBe(
      join("/state", "loop-runs", "hub", "run-1", "supervisor-final-summary.json"),
    );
    expect(loopRunArtifactPath("hub", "run-1", "evalReport", "/state")).toBe(
      join("/state", "loop-runs", "hub", "run-1", "eval-report.json"),
    );
    expect(loopRunArtifactPath("hub", "run-1", "handoffJson", "/state")).toBe(
      join("/state", "loop-runs", "hub", "run-1", "handoff.json"),
    );
    expect(loopRunArtifactPath("hub", "run-1", "handoffMarkdown", "/state")).toBe(
      join("/state", "loop-runs", "hub", "run-1", "handoff.md"),
    );
  });
});
