import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { LOOP_RUN_ARTIFACTS, loopRunDir, loopRunsRoot } from "./artifacts.js";
import {
  type LoopReportQuery,
  type LoopReportQueryResult,
  type LoopReportRecord,
  listLoopReportRecords,
  queryLoopReportRecords,
} from "./report-catalog.js";
import type { LoopRunSummary } from "./run.js";

export type { LoopReportRecord };

function reportsRoot(): string {
  return loopRunsRoot();
}

function reportDir(projectId: string, runId: string): string {
  return loopRunDir(projectId, runId);
}

function renderMarkdown(
  summary: LoopRunSummary,
  record: Omit<LoopReportRecord, "markdownPath" | "summaryPath">,
): string {
  return [
    `# Loop Run: ${summary.projectName}`,
    "",
    `- Run: ${record.runId}`,
    `- Project: ${summary.projectId}`,
    `- Status: ${summary.status}`,
    `- Started: ${new Date(record.startedAt).toISOString()}`,
    `- Ended: ${new Date(record.endedAt).toISOString()}`,
    `- Committed: ${summary.committed}`,
    "",
    summary.skills.approved.length > 0 ? "## Skills" : "",
    "",
    ...summary.skills.approved.map((skill) =>
      [
        `- ${skill.id}`,
        `  - Ref: \`${skill.ref}\``,
        `  - Checksum: \`${skill.checksum}\``,
        skill.sourcePath !== undefined ? `  - Path: \`${skill.sourcePath}\`` : "",
        `  - Platforms: ${skill.platforms.join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "## Commands",
    "",
    ...summary.commands.flatMap((command) => [
      `### ${command.kind}`,
      "",
      `- Command: \`${command.command}\``,
      `- Exit: ${command.status}`,
      "",
      "```text",
      command.stdout,
      "```",
      "",
      command.stderr ? "```text" : "",
      command.stderr,
      command.stderr ? "```" : "",
      "",
    ]),
    summary.suggestedBotImprovements.length > 0 ? "## Suggested Bot Improvements" : "",
    "",
    ...summary.suggestedBotImprovements.map((item) => `- ${item}`),
    "",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

export function writeLoopRunReport(
  summary: LoopRunSummary,
  opts: { runId?: string; startedAt: number; endedAt: number },
): LoopReportRecord {
  const runId = opts.runId ?? `${opts.startedAt}-${summary.projectId}`;
  const dir = reportDir(summary.projectId, runId);
  mkdirSync(dir, { recursive: true });
  const markdownPath = join(dir, LOOP_RUN_ARTIFACTS.commandMarkdown);
  const summaryPath = join(dir, LOOP_RUN_ARTIFACTS.commandSummary);
  const record: LoopReportRecord = {
    runId,
    projectId: summary.projectId,
    projectName: summary.projectName,
    status: summary.status,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    markdownPath,
    summaryPath,
  };
  writeFileAtomicSync(summaryPath, `${JSON.stringify({ record, summary }, null, 2)}\n`);
  writeFileAtomicSync(markdownPath, renderMarkdown(summary, record));
  return record;
}

export function listLoopReports(): LoopReportRecord[] {
  return listLoopReportRecords(reportsRoot());
}

/** Bounded, filtered, path-safe report view for operator and agent surfaces. */
export function queryLoopReports(query: LoopReportQuery = {}): LoopReportQueryResult {
  return queryLoopReportRecords(reportsRoot(), query);
}
