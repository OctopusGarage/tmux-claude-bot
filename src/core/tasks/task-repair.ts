import type { TaskAuditItem } from "./task-ledger.js";

export function buildDailyAuditRepairPrompt(input: {
  repoPath: string;
  repairBranch: string;
  items: TaskAuditItem[];
}): string {
  return [
    "Daily scheduled task audit repair.",
    "",
    `Repository: ${input.repoPath}`,
    `Repair branch: ${input.repairBranch}`,
    "",
    "Failed or missing scheduled tasks:",
    JSON.stringify(input.items, null, 2),
    "",
    "Required process:",
    `- cd ${shellQuote(input.repoPath)}`,
    "- Confirm the worktree is clean with git status --short. If it is dirty, stop and report blocked.",
    `- git fetch origin ${input.repairBranch}`,
    `- git switch ${input.repairBranch}`,
    "- Review the evidence for each failed or missing task before deciding whether any edit is needed.",
    "- Do not assume every failure is a code bug.",
    "- Classify each failure as: bot code bug, target project failure, external service/auth/network issue, missing instrumentation, or still-running/stale state.",
    `- Before editing or committing bot code, verify ${input.repairBranch} can be safely updated: git pull --ff-only origin ${input.repairBranch}.`,
    "- If the branch cannot fast-forward, continue the evidence review and classification, but do not edit or commit; report the branch sync blocker separately.",
    "- Fix one failure at a time, and only edit tmux-claude-bot code when the bot caused or misclassified the failure.",
    "- Do not change external project code from this repair task.",
    "- Run npm run verify:local after code changes.",
    "- Review the diff after verification.",
    "- Commit verified bot fixes to the repair branch with a clear message.",
    "- If nothing is safe to fix in this repo, do not commit; report the blockers clearly.",
    "",
    "Final response:",
    "- Summarize classification, changes, verification, commits, and remaining blockers.",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
