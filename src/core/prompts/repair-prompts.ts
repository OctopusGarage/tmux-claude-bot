import type { AppConfig } from "../../shared/types.js";
import type { TaskAuditItem } from "../tasks/task-ledger.js";

type RuntimeGuardianRepairFinding = {
  kind: string;
  severity: string;
  runId: string;
  projectId: string;
  projectPath: string;
  evidence: string[];
  runDir?: string;
};

export function buildDailyAuditRepairPrompt(input: {
  repoPath: string;
  repairBranch: string;
  items: TaskAuditItem[];
}): string {
  const count = input.items.length;
  return [
    "Daily scheduled task audit repair.",
    "",
    `Repository: ${input.repoPath}`,
    `Repair branch: ${input.repairBranch}`,
    "",
    "Problem statement:",
    `The daily task audit found ${count} unresolved scheduled task${count === 1 ? "" : "s"} that may indicate a tmux-claude-bot scheduling, supervisor, notification, ledger, or validation bug.`,
    "Your job is not to assume a code bug. First make the problem explicit, verify the evidence, then submit only justified repair work.",
    "",
    "Failed or missing scheduled tasks:",
    JSON.stringify(input.items, null, 2),
    "",
    "Review and confirmation gate:",
    "- For each item, first write the concrete problem statement in plain language: expected behavior, actual result, affected task id, source, failure kind, and evidence.",
    "- Reproduce or independently confirm the failure from ledger records, reports, logs, git state, or scheduler configuration before editing.",
    "- Do not edit code until the failure is independently confirmed as a real tmux-claude-bot code or configuration issue.",
    "- If the problem is a target-project failure, external service/auth/network issue, stale running state, or already superseded by a later success, do not change bot code; update the task repair status and report the blocker clearly.",
    "- Before any code change, record the pre-mutation review in the supervisor final summary reviewGate: confirmed problem, evidence source, classification, scope boundary, and why a bot code/config fix is justified.",
    "- After any code change, record the post-mutation review in reviewGate: diff reviewed, original failure path addressed, regression/scheduler/ledger/notification/system-gate risks checked, and deterministic gates run.",
    "- AI review/eval may be used only through the existing Claude Code / Codex control surface. It is advisory evidence; deterministic gates remain authoritative for final acceptance.",
    "",
    "Required process:",
    `- cd ${shellQuote(input.repoPath)}`,
    "- Confirm the worktree is clean with git status --short. If it is dirty, stop and report blocked.",
    `- git fetch origin ${input.repairBranch}`,
    `- git switch ${input.repairBranch}`,
    "- Review the evidence for each failed or missing task before deciding whether any edit is needed.",
    "- Do not assume every failure is a code bug.",
    "- Use each task's failureKind as a hint, then independently verify the evidence before acting.",
    "- Classify each failure as: bot code bug, target project failure, external service/auth/network issue, missing instrumentation, or still-running/stale state.",
    "- If a later successful task already proves the same scheduled job recovered, do not edit code; report the same task id with --repair-status superseded.",
    `- Before editing or committing bot code, sync ${input.repairBranch} with git pull --rebase origin ${input.repairBranch}.`,
    "- If the branch cannot rebase cleanly, continue the evidence review and classification, but do not edit or commit; report the branch sync blocker separately.",
    "- Fix one failure at a time, and only edit tmux-claude-bot code when the bot caused or misclassified the failure.",
    "- Do not change external project code from this repair task.",
    "- Run npm run verify:local after code changes.",
    "- Review the diff after verification.",
    "- Commit verified bot fixes to the repair branch with a clear message.",
    "- If nothing is safe to fix in this repo, do not commit; report the blockers clearly.",
    "- For every reviewed item, update the same task id with tcb task report and the final --repair-status: fixed, superseded, not-reproducible, blocked, or failed.",
    "",
    "Final response:",
    "- Summarize classification, changes, verification, commits, and remaining blockers.",
  ].join("\n");
}

export function buildRuntimeGuardianRepairPrompt(input: {
  repoPath: string;
  repairBranch: string;
  mode: AppConfig["runtimeGuardian"]["mode"];
  findings: RuntimeGuardianRepairFinding[];
}): string {
  return [
    `Runtime Guardian (${input.mode}) found confirmed tmux-claude-bot runtime issue(s).`,
    `Repository: ${input.repoPath}`,
    `Base branch: ${input.repairBranch}`,
    "",
    "Scope:",
    "- Fix tmux-claude-bot system-layer/runtime orchestration issues only.",
    "- Do not edit target project repositories mentioned in findings.",
    "- Prioritize scheduler correctness, supervisor/worker state, system gates, notifications, launchd/dev-service behavior, and task-audit reporting.",
    "- If a finding says a read-only smoke task was blocked by target dependency preflight, fix the bot WorkOrder verification profile or worktree policy; do not install target-project dependencies from this repair.",
    "- Before editing, re-check the evidence and prove the issue is real; if not real, make no changes.",
    "- Before editing, write a pre-mutation review in the supervisor final summary reviewGate: confirmed finding, affected system path, reachability, scope boundary, and why a tmux-claude-bot code/config change is justified.",
    "- Fix narrowly, add or update a focused regression test when practical, run relevant verification, inspect the diff, and commit only verified fixes.",
    "- After editing, write a post-mutation review in reviewGate: diff reviewed, original runtime failure path addressed, regression/security/scheduler/state/notification/PR-gate risks checked, and deterministic gates run.",
    "- AI review/eval may be used only through the existing Claude Code / Codex control surface. It is advisory; deterministic gates and system acceptance remain authoritative.",
    "- Use CodeGraph before grep/find when .codegraph exists. Read AGENTS.md and CLAUDE.md before code changes.",
    "- Do not open a PR; the supervisor/system layer handles PR and merge gates.",
    "",
    "Findings:",
    JSON.stringify(input.findings, null, 2),
    "",
    "source=runtime-guardian",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
