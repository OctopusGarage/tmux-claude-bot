import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { LOOP_RUN_ARTIFACTS, loopRunDir } from "./artifacts.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import type { LoopSupervisorFinalSummary, LoopWorkOrder } from "./work-order.js";

type LoopSupervisorReportInput = {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  startedAt: number;
  endedAt: number;
  result: LoopSupervisedRunResult;
};

type LoopSupervisorReportRecord = {
  runId: string;
  markdownPath: string;
  summaryPath: string;
};

type LoopSupervisorReportSummary = {
  workOrderId: string;
  runId: string;
  project: {
    id: string;
    name: string;
    path: string;
    agent: LoopWorkOrder["agent"];
  };
  status: LoopSupervisedRunResult["status"];
  supervisor: {
    session: string;
  };
  timestamps: {
    scheduledAt: number;
    startedAt: number;
    endedAt: number;
  };
  result: {
    status: LoopSupervisedRunResult["status"];
    output: string;
    reason?: string;
    summary?: LoopSupervisorFinalSummary;
  };
};

function reportDir(projectId: string, runId: string): string {
  return loopRunDir(projectId, runId);
}

function resultSummary(result: LoopSupervisedRunResult): LoopSupervisorFinalSummary | undefined {
  return "summary" in result ? result.summary : undefined;
}

function resultReason(result: LoopSupervisedRunResult): string | undefined {
  return "reason" in result ? result.reason : undefined;
}

function renderActions(summary: LoopSupervisorFinalSummary | undefined): string[] {
  if (summary === undefined) return ["- No final supervisor summary was available."];
  if (summary.actionsTaken.length === 0) return ["- No actions were reported."];
  return summary.actionsTaken.map((action) => `- ${action}`);
}

function renderMarkdown(input: LoopSupervisorReportInput): string {
  const summary = resultSummary(input.result);
  return [
    "# Loop Supervisor Report",
    "",
    `- Work Order: ${input.workOrder.id}`,
    `- Project: ${input.workOrder.projectName} (\`${input.workOrder.projectId}\`)`,
    `- Status: ${input.result.status}`,
    `- Supervisor: ${input.supervisorSession}`,
    `- Started: ${new Date(input.startedAt).toISOString()}`,
    `- Ended: ${new Date(input.endedAt).toISOString()}`,
    "",
    "## Actions Taken",
    "",
    ...renderActions(summary),
    "",
    "## Raw Output",
    "",
    "```text",
    input.result.output,
    "```",
    "",
  ].join("\n");
}

function buildSummary(input: LoopSupervisorReportInput): LoopSupervisorReportSummary {
  const reason = resultReason(input.result);
  const summary = resultSummary(input.result);
  const result: LoopSupervisorReportSummary["result"] = {
    status: input.result.status,
    output: input.result.output,
  };
  if (reason !== undefined) result.reason = reason;
  if (summary !== undefined) result.summary = summary;

  return {
    workOrderId: input.workOrder.id,
    runId: input.workOrder.id,
    project: {
      id: input.workOrder.projectId,
      name: input.workOrder.projectName,
      path: input.workOrder.projectPath,
      agent: input.workOrder.agent,
    },
    status: input.result.status,
    supervisor: {
      session: input.supervisorSession,
    },
    timestamps: {
      scheduledAt: input.workOrder.scheduledAt,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    },
    result,
  };
}

export function writeLoopSupervisorReport(
  input: LoopSupervisorReportInput,
): LoopSupervisorReportRecord {
  const runId = input.workOrder.id;
  const dir = reportDir(input.workOrder.projectId, runId);
  mkdirSync(dir, { recursive: true });

  const markdownPath = join(dir, LOOP_RUN_ARTIFACTS.supervisorMarkdown);
  const summaryPath = join(dir, LOOP_RUN_ARTIFACTS.supervisorSummary);

  writeFileAtomicSync(summaryPath, `${JSON.stringify(buildSummary(input), null, 2)}\n`);
  writeFileAtomicSync(markdownPath, renderMarkdown(input));

  return { runId, markdownPath, summaryPath };
}
