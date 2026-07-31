import type { TaskAuditItem } from "./task-ledger.js";

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
    `- Before editing or committing bot code, verify ${input.repairBranch} can be safely updated: git pull --ff-only origin ${input.repairBranch}.`,
    "- If the branch cannot fast-forward, continue the evidence review and classification, but do not edit or commit; report the branch sync blocker separately.",
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
