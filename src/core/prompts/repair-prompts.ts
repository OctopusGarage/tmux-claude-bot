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

export function buildResourceGuardianRepairPrompt(input: {
  repoPath: string;
  repairBranch: string;
  incident: { id: string; fingerprint: string; evidence: readonly string[] };
}): string {
  return [
    "Resource Guardian stable-recovery repair.",
    `Repository: ${input.repoPath}`,
    `Repair branch: ${input.repairBranch}`,
    `Incident: ${input.incident.id}`,
    `Fingerprint: ${input.incident.fingerprint}`,
    "",
    "Scope and safety:",
    "- Work only in this tmux-claude-bot repository; never edit a target project.",
    "- Confirm `git -C <configured-repository> rev-parse --show-toplevel` before mutation.",
    "- Re-check the bounded incident evidence before editing and make no change unless the bot caused a reproducible issue.",
    "- Use the active Claude Code / Codex agent surface only; never add model-provider SDKs, keys, or HTTP clients.",
    "- Do not create or open a PR.",
    "- Stop when the evidence does not prove a bot-owned reproducible defect; do not optimize, refactor, or broaden scope speculatively.",
    "- Commit only a verified, narrow repair; preserve unrelated work and do not amend or rewrite unrelated history.",
    "",
    "Required loop: Explore -> Plan -> Code -> Verify -> Review -> Record.",
    "- Explore the evidence and relevant deterministic contracts first.",
    "- Record a pre-mutation reviewGate with the confirmed failure, reachability, evidence, and bounded scope before changing code.",
    "- Plan the smallest repair with a clear stop condition.",
    "- Code only a confirmed bot-owned defect and preserve unrelated work.",
    "- Run npm run verify:local after changes.",
    "- Review the diff and record a post-mutation reviewGate with regression, evaluation, monitoring, and documentation follow-up candidates.",
    "- On failure, add a focused regression/eval/monitor/documentation candidate or record why none is justified.",
    "",
    "Incident evidence:",
    JSON.stringify(input.incident.evidence.slice(0, 20), null, 2),
    "",
    "source=resource-guardian",
  ].join("\n");
}

export function buildProjectRecoveryPrompt(input: {
  projectId: string;
  projectPath: string;
  taskFamily: string;
  classification: string;
  reason: string;
  taskIds: string[];
  evidence: string[];
}): string {
  const assessmentContractGuidance = hasAssessmentScoringContractEvidence([
    input.reason,
    ...input.evidence,
  ])
    ? [
        "",
        "Assessment scoring contract recovery:",
        "- Do not ask for an owner decision solely because score is null or a numeric score is missing.",
        "- First reproduce the assessment command output and confirm whether actionable findings, targetScore, or decision fields are present.",
        "- If the configured assessment command is project-owned, make the assessment command emit a deterministic numeric score and preserve its actionable findings.",
        "- If the failure is caused by tmux-claude-bot parsing, scheduling, or prompt-contract logic, repair the bot-side assessment contract and do not edit the target project source.",
        "- After repair, rerun the assessment path and verify the original tasks can receive a final fixed, superseded, or blocked report with concrete evidence.",
      ]
    : [];
  return [
    "Historical scheduled task recovery for a configured project.",
    `Project: ${input.projectId}`,
    `Repository: ${input.projectPath}`,
    `Task family: ${input.taskFamily}`,
    `Recovery classification: ${input.classification}`,
    `Classification reason: ${input.reason}`,
    "",
    "Scope:",
    "- Work only in the configured project repository and its existing Loop worktree policy.",
    "- Re-check the original evidence before editing; do not assume the historical failure is a code bug.",
    "- Do not resolve draft PR policy, merge conflicts, external CI/account failures, or design decisions by guessing.",
    "- If the blocker remains, report it as blocked and do not claim a fix.",
    "- Reuse the project's configured agent, branch, verification profile, and PR policy.",
    "",
    "Original task ids that must receive a final report:",
    JSON.stringify(input.taskIds),
    "",
    "Evidence:",
    JSON.stringify(input.evidence, null, 2),
    ...assessmentContractGuidance,
    "",
    "Required finalization:",
    "- Verify the target worktree and branch before mutation.",
    "- Make the smallest justified repair only when the project caused the failure.",
    "- Run the configured deterministic verification gates.",
    "- Record classification, evidence, changes, verification, commit/PR state, and remaining blockers.",
    "- Update every original task id with its final repair status.",
  ].join("\n");
}

function hasAssessmentScoringContractEvidence(values: string[]): boolean {
  const evidence = values.join(" ").toLowerCase();
  return /(assessment (result|score|scoring).*numeric score|numeric score.*assessment|score:null|assessment score contract|assessment scoring contract|targetscore)/.test(
    evidence,
  );
}

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
