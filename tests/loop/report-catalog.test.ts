import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLoopReportRecords } from "../../src/core/loop/report-catalog.js";

describe("listLoopReportRecords", () => {
  it("projects command and supervisor report files into one report record list", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcb-loop-report-catalog-"));
    const commandDir = join(root, "hub", "run-command");
    const supervisorDir = join(root, "hub", "run-supervisor");
    mkdirSync(commandDir, { recursive: true });
    mkdirSync(supervisorDir, { recursive: true });
    writeFileSync(
      join(commandDir, "summary.json"),
      `${JSON.stringify({
        record: {
          runId: "run-command",
          projectId: "hub",
          projectName: "Hub",
          status: "passed",
          startedAt: 1_000,
          endedAt: 2_000,
          markdownPath: join(commandDir, "report.md"),
          summaryPath: join(commandDir, "summary.json"),
        },
      })}\n`,
    );
    writeFileSync(
      join(supervisorDir, "supervisor-summary.json"),
      `${JSON.stringify({
        runId: "run-supervisor",
        project: { id: "hub", name: "Hub" },
        status: "completed",
        timestamps: { startedAt: 3_000, endedAt: 4_000 },
      })}\n`,
    );

    expect(listLoopReportRecords(root).map((record) => [record.runId, record.status])).toEqual([
      ["run-supervisor", "passed"],
      ["run-command", "passed"],
    ]);
  });
});
