import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { LOOP_RUN_ARTIFACTS, loopRunDir } from "./artifacts.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import { loopWorkOrderTaskKind } from "./task-family.js";
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
  handoffJsonPath: string;
  handoffMarkdownPath: string;
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

type LoopSupervisorHandoff = {
  version: 1;
  workOrderId: string;
  runId: string;
  generatedAt: number;
  project: {
    id: string;
    name: string;
    path: string;
  };
  status: LoopSupervisedRunResult["status"];
  objective: {
    goal: string;
    taskKind: string;
    targetScore: number;
    maxRounds: number;
  };
  planning?: NonNullable<LoopWorkOrder["planning"]>;
  progress: {
    actionsTaken: string[];
    commits: string[];
    finalVerification: LoopSupervisorFinalSummary["finalVerification"] | "not-available";
    planReview?: LoopSupervisorFinalSummary["planReview"];
  };
  nextAgent: {
    resumeFrom: string[];
    nextSteps: string[];
    stopWhen: string[];
    risks: string[];
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

function buildHandoff(
  input: LoopSupervisorReportInput,
  paths: { markdownPath: string; summaryPath: string },
): LoopSupervisorHandoff {
  const summary = resultSummary(input.result);
  const reason = resultReason(input.result);
  const status = input.result.status;
  const followUps = summary?.followUps ?? [];
  const planning = input.workOrder.planning;
  const risks = [
    ...(summary?.planReview?.remainingRisks ?? []),
    ...(status === "completed" ? [] : [reason ?? `supervisor result status is ${status}`]),
  ];
  const nextSteps =
    followUps.length > 0
      ? followUps
      : status === "completed"
        ? ["No follow-up was reported. Inspect system-gate.json before starting related work."]
        : [
            "Inspect supervisor output, system-gate.json, and work-order-state.json before retrying.",
            "Retry only after the concrete blocker is resolved or the WorkOrder is narrowed.",
          ];
  const stopWhen = [
    ...(planning?.stopConditions ?? []),
    "Stop when system-gate.json accepts the run, or when a concrete blocker is proven with evidence.",
    "Do not continue opportunistic optimization after acceptance criteria and verification are satisfied.",
  ];

  return {
    version: 1,
    workOrderId: input.workOrder.id,
    runId: input.workOrder.id,
    generatedAt: input.endedAt,
    project: {
      id: input.workOrder.projectId,
      name: input.workOrder.projectName,
      path: input.workOrder.projectPath,
    },
    status,
    objective: {
      goal: input.workOrder.goal,
      taskKind: loopWorkOrderTaskKind(input.workOrder),
      targetScore: input.workOrder.targetScore,
      maxRounds: input.workOrder.maxRounds,
    },
    ...(planning !== undefined ? { planning } : {}),
    progress: {
      actionsTaken: summary?.actionsTaken ?? [],
      commits: summary?.commits ?? [],
      finalVerification: summary?.finalVerification ?? "not-available",
      ...(summary?.planReview !== undefined ? { planReview: summary.planReview } : {}),
    },
    nextAgent: {
      resumeFrom: [
        paths.summaryPath,
        paths.markdownPath,
        input.workOrder.finalSummaryPath ?? "supervisor-final-summary.json was not configured",
        "system-gate.json",
        "work-order-state.json",
      ],
      nextSteps,
      stopWhen,
      risks,
    },
  };
}

function renderList(items: readonly string[], empty: string): string[] {
  if (items.length === 0) return [`- ${empty}`];
  return items.map((item) => `- ${item}`);
}

function renderHandoffMarkdown(handoff: LoopSupervisorHandoff): string {
  return [
    "# Loop WorkOrder Handoff",
    "",
    `- Work Order: ${handoff.workOrderId}`,
    `- Project: ${handoff.project.name} (\`${handoff.project.id}\`)`,
    `- Status: ${handoff.status}`,
    `- Task Kind: ${handoff.objective.taskKind}`,
    `- Generated: ${new Date(handoff.generatedAt).toISOString()}`,
    "",
    "## Objective",
    "",
    handoff.objective.goal,
    "",
    "## Acceptance Criteria",
    "",
    ...renderList(
      handoff.planning?.acceptanceCriteria ?? [],
      "No structured acceptance criteria were recorded.",
    ),
    "",
    "## Progress",
    "",
    `- Final verification: ${handoff.progress.finalVerification}`,
    ...renderList(handoff.progress.actionsTaken, "No actions were reported."),
    "",
    "## Commits",
    "",
    ...renderList(handoff.progress.commits, "No commits were reported."),
    "",
    "## Next Steps",
    "",
    ...renderList(handoff.nextAgent.nextSteps, "No next step was reported."),
    "",
    "## Stop Conditions",
    "",
    ...renderList(handoff.nextAgent.stopWhen, "No stop condition was recorded."),
    "",
    "## Risks",
    "",
    ...renderList(handoff.nextAgent.risks, "No remaining risk was reported."),
    "",
    "## Resume From",
    "",
    ...renderList(handoff.nextAgent.resumeFrom, "No resume artifact was recorded."),
    "",
  ].join("\n");
}

export function writeLoopSupervisorReport(
  input: LoopSupervisorReportInput,
): LoopSupervisorReportRecord {
  const runId = input.workOrder.id;
  const dir = reportDir(input.workOrder.projectId, runId);
  mkdirSync(dir, { recursive: true });

  const markdownPath = join(dir, LOOP_RUN_ARTIFACTS.supervisorMarkdown);
  const summaryPath = join(dir, LOOP_RUN_ARTIFACTS.supervisorSummary);
  const handoffJsonPath = join(dir, LOOP_RUN_ARTIFACTS.handoffJson);
  const handoffMarkdownPath = join(dir, LOOP_RUN_ARTIFACTS.handoffMarkdown);
  const handoff = buildHandoff(input, { markdownPath, summaryPath });

  writeFileAtomicSync(summaryPath, `${JSON.stringify(buildSummary(input), null, 2)}\n`);
  writeFileAtomicSync(markdownPath, renderMarkdown(input));
  writeFileAtomicSync(handoffJsonPath, `${JSON.stringify(handoff, null, 2)}\n`);
  writeFileAtomicSync(handoffMarkdownPath, renderHandoffMarkdown(handoff));

  return { runId, markdownPath, summaryPath, handoffJsonPath, handoffMarkdownPath };
}
