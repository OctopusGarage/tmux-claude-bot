import type { ApprovedSkill } from "../skills/schema.js";
import type { LoopConfig, LoopProjectConfig } from "./config.js";

export type SupervisorFinalStatus = "completed" | "failed" | "blocked" | "timeout" | "cancelled";

export type LoopSupervisorFinalSummary = {
  status: SupervisorFinalStatus;
  projectId: string;
  actionsTaken: string[];
  delegatedTasks: Array<{ projectId: string; status: SupervisorFinalStatus }>;
  finalVerification: "passed" | "failed" | "not-run" | "unknown";
  commits: string[];
  followUps: string[];
};

export type LoopWorkOrder = {
  id: string;
  scheduledAt: number;
  projectId: string;
  projectName: string;
  projectPath: string;
  agent: LoopProjectConfig["agent"];
  goal: string;
  maxRounds: number;
  targetScore: number;
  runner: LoopProjectConfig["runner"];
  allowedActions: string[];
  blockedActions: string[];
  skills: { approved: ApprovedSkill[] };
  preflight: LoopProjectConfig["preflight"];
  assessment: LoopProjectConfig["assessment"];
  eval?: LoopProjectConfig["eval"];
  execution: LoopProjectConfig["execution"];
  recovery: LoopProjectConfig["recovery"];
  commitPolicy: LoopProjectConfig["commit"];
  requiredFinalMarker: string;
};

type ParseSupervisorFinalSummaryResult =
  | { ok: true; summary: LoopSupervisorFinalSummary }
  | { ok: false; reason: "missing-final-marker" | "invalid-summary" };

const SUPERVISOR_FINAL_STATUSES = new Set<SupervisorFinalStatus>([
  "completed",
  "failed",
  "blocked",
  "timeout",
  "cancelled",
]);

const FINAL_VERIFICATION_STATUSES = new Set<LoopSupervisorFinalSummary["finalVerification"]>([
  "passed",
  "failed",
  "not-run",
  "unknown",
]);

export function finalMarkerForWorkOrder(workOrderId: string): string {
  return `[LOOP_SUPERVISOR_DONE:${workOrderId}]`;
}

export function buildLoopWorkOrder(input: {
  config: LoopConfig;
  project: LoopProjectConfig;
  scheduledAt: number;
  runId: string;
}): LoopWorkOrder {
  const workOrder: LoopWorkOrder = {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    projectId: input.project.id,
    projectName: input.project.name,
    projectPath: input.project.path,
    agent: input.project.agent,
    goal: input.project.goal,
    maxRounds: input.project.maxRounds,
    targetScore: input.project.targetScore,
    runner: input.project.runner,
    allowedActions: [...input.project.allowedActions],
    blockedActions: [...input.project.blockedActions],
    skills: { approved: [...input.config.skills.approved] },
    preflight: input.project.preflight,
    assessment: input.project.assessment,
    execution: input.project.execution,
    recovery: input.project.recovery,
    commitPolicy: input.project.commit,
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
  };

  if (input.project.eval !== undefined) {
    workOrder.eval = input.project.eval;
  }

  return workOrder;
}

export function buildLoopSupervisorPrompt(workOrder: LoopWorkOrder): string {
  return [
    "You are the Loop Supervisor for tmux-claude-bot.",
    "",
    "WorkOrder JSON:",
    JSON.stringify(workOrder, null, 2),
    "",
    "Policy:",
    "- Execute only this bounded work order.",
    "- Work in focused rounds and stop at the configured limits.",
    "- Use the currently running Claude Code / Codex agent capability only.",
    "- Do not call model-provider APIs.",
    "- Do not add model SDKs, model API keys, or direct model HTTP integrations.",
    "- Respect allowedActions and blockedActions exactly.",
    "- Preserve unrelated user work and avoid broad rewrites.",
    "",
    "Available tcb commands:",
    "- tcb dashboard --json",
    "- tcb sessions",
    "- tcb open <project>",
    "- tcb peek <project>",
    '- tcb send <project> "<task>"',
    "- tcb loop run <config> <projectId>",
    "- tcb notify ...",
    "",
    "Required final response:",
    `- Print ${workOrder.requiredFinalMarker} on its own line.`,
    "- Immediately after the marker, print strict JSON with fields: status, projectId, actionsTaken, delegatedTasks, finalVerification, commits, followUps.",
  ].join("\n");
}

export function parseSupervisorFinalSummary(
  output: string,
  workOrderId: string,
): ParseSupervisorFinalSummaryResult {
  const marker = finalMarkerForWorkOrder(workOrderId);
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) return { ok: false, reason: "missing-final-marker" };

  const rawJson = extractFirstJsonObject(output.slice(markerIndex + marker.length));
  if (rawJson === null) return { ok: false, reason: "invalid-summary" };

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const summary = parseSummaryObject(parsed);
    return summary === null ? { ok: false, reason: "invalid-summary" } : { ok: true, summary };
  } catch {
    return { ok: false, reason: "invalid-summary" };
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

function parseSummaryObject(value: unknown): LoopSupervisorFinalSummary | null {
  if (!isRecord(value)) return null;
  const status = parseSupervisorFinalStatus(value.status);
  const projectId = typeof value.projectId === "string" ? value.projectId : null;
  const actionsTaken = parseStringArray(value.actionsTaken);
  const delegatedTasks = parseDelegatedTasks(value.delegatedTasks);
  const finalVerification = parseFinalVerification(value.finalVerification);
  const commits = parseStringArray(value.commits);
  const followUps = parseStringArray(value.followUps);

  if (
    status === null ||
    projectId === null ||
    actionsTaken === null ||
    delegatedTasks === null ||
    finalVerification === null ||
    commits === null ||
    followUps === null
  ) {
    return null;
  }

  return {
    status,
    projectId,
    actionsTaken,
    delegatedTasks,
    finalVerification,
    commits,
    followUps,
  };
}

function parseDelegatedTasks(value: unknown): LoopSupervisorFinalSummary["delegatedTasks"] | null {
  if (!Array.isArray(value)) return null;
  const tasks: LoopSupervisorFinalSummary["delegatedTasks"] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.projectId !== "string") return null;
    const status = parseSupervisorFinalStatus(item.status);
    if (status === null) return null;
    tasks.push({ projectId: item.projectId, status });
  }
  return tasks;
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function parseSupervisorFinalStatus(value: unknown): SupervisorFinalStatus | null {
  return typeof value === "string" && SUPERVISOR_FINAL_STATUSES.has(value as SupervisorFinalStatus)
    ? (value as SupervisorFinalStatus)
    : null;
}

function parseFinalVerification(
  value: unknown,
): LoopSupervisorFinalSummary["finalVerification"] | null {
  return typeof value === "string" &&
    FINAL_VERIFICATION_STATUSES.has(value as LoopSupervisorFinalSummary["finalVerification"])
    ? (value as LoopSupervisorFinalSummary["finalVerification"])
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
