import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvalReportFile } from "../eval/report.js";
import type { EvalOutcome } from "../eval/types.js";
import { LOOP_RUN_ARTIFACTS } from "./artifacts.js";

export type LoopReportRecord = {
  runId: string;
  projectId: string;
  projectName: string;
  status: "passed" | "failed";
  startedAt: number;
  endedAt: number;
  markdownPath: string;
  summaryPath: string;
  evalReportPath?: string;
  evalOutcome?: Pick<EvalOutcome, "status" | "finalVerification" | "reviewDecision" | "reason">;
};

type LoopSupervisorReportSummary = {
  runId: string;
  project: {
    id: string;
    name: string;
  };
  status: string;
  timestamps: {
    startedAt: number;
    endedAt: number;
  };
  evalReportPath?: string;
};

export function listLoopReportRecords(root: string): LoopReportRecord[] {
  if (!existsSync(root)) return [];
  const records: LoopReportRecord[] = [];
  for (const projectId of readdirSync(root)) {
    const projectDir = join(root, projectId);
    for (const runId of readdirSync(projectDir)) {
      const record = readReportRecord(join(projectDir, runId));
      if (record !== null) records.push(record);
    }
  }
  return records.sort(
    (a, b) => b.startedAt - a.startedAt || a.projectId.localeCompare(b.projectId),
  );
}

function readReportRecord(dir: string): LoopReportRecord | null {
  try {
    return readCommandReportRecord(dir) ?? readSupervisorReportRecord(dir);
  } catch {
    return null;
  }
}

function readCommandReportRecord(dir: string): LoopReportRecord | null {
  const summaryPath = join(dir, LOOP_RUN_ARTIFACTS.commandSummary);
  if (!existsSync(summaryPath)) return null;
  const parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    record?: LoopReportRecord;
  };
  return parsed.record ?? null;
}

function readSupervisorReportRecord(dir: string): LoopReportRecord | null {
  const summaryPath = join(dir, LOOP_RUN_ARTIFACTS.supervisorSummary);
  if (!existsSync(summaryPath)) return null;
  const supervisor = JSON.parse(readFileSync(summaryPath, "utf8")) as LoopSupervisorReportSummary;
  const defaultEvalReportPath = join(dir, LOOP_RUN_ARTIFACTS.evalReport);
  const evalReportPath =
    supervisor.evalReportPath ??
    (existsSync(defaultEvalReportPath) ? defaultEvalReportPath : undefined);
  const evalReport = readEvalReportFile(evalReportPath);
  const evalOutcome = evalReport.ok ? evalReport.report.outcome : undefined;
  return {
    runId: supervisor.runId,
    projectId: supervisor.project.id,
    projectName: supervisor.project.name,
    status: supervisor.status === "completed" ? "passed" : "failed",
    startedAt: supervisor.timestamps.startedAt,
    endedAt: supervisor.timestamps.endedAt,
    markdownPath: join(dir, LOOP_RUN_ARTIFACTS.supervisorMarkdown),
    summaryPath,
    ...(evalReportPath !== undefined ? { evalReportPath } : {}),
    ...(evalOutcome !== undefined ? { evalOutcome } : {}),
  };
}
