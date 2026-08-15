import type {
  HarnessAutoSubtask,
  LoopCleanupPolicy,
  LoopWorkOrder,
  LoopWorkOrderTask,
} from "../loop/work-order-contract.js";
import { opportunityReportPath } from "../opportunities/store.js";

export function buildLoopWorkspacePolicyLines(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (workOrder.workspace === undefined) return [];
  const branchKind = task.kind === "workspace-architecture" ? "architecture" : task.kind;
  return [
    "Workspace multi-repository task.",
    `- Treat ${workOrder.projectName} as one bounded workspace with ${workOrder.workspace.repositories.length} repositories.`,
    `- Workspace root ${workOrder.workspace.root} is a coordination directory and may contain multiple independent git repositories. Verify it exists, but do not require the workspace root itself to be a git repository.`,
    "- Git safety checks are repository-scoped: before syncing, assessing, editing, committing, pushing, or opening a PR, verify the affected repository's git toplevel equals that repository path.",
    "- First decide which repositories are actually affected. Do not force every repository to change. When the evidence points to only one repository, keep the change there.",
    "- Inspect contracts between repositories before editing affected areas: API routes, schemas, generated clients, shared DTOs, auth/session assumptions, build/deploy coupling, error handling, and data/state ownership.",
    "- If a change crosses repository boundaries, update all affected repositories in the same round and verify the contract from every affected side.",
    "- Each repository keeps its own git branch and pull request. Use one shared run id, link the related PRs in every PR body, and describe the cross-repository reason clearly.",
    ...workOrder.workspace.repositories.map((repository) =>
      repository.sourcePath === undefined
        ? `- For ${repository.id}, use branch loop/${repository.id}/${branchKind}/${workOrder.id}, open the PR against ${repository.pullRequest.base}, switch back to ${repository.pullRequest.switchBack}, and ${workspaceGithubPolicy(repository)}.`
        : `- For ${repository.id}, use isolated worktree ${repository.path}, create branch loop/${repository.id}/${branchKind}/${workOrder.id} from origin/${repository.pullRequest.base}, open the PR against ${repository.pullRequest.base}, keep original worktree ${repository.sourcePath} clean on ${repository.pullRequest.switchBack}, and ${workspaceGithubPolicy(repository)}.`,
    ),
    "- Before finalizing, verify every changed repository worktree is clean, every original repository worktree is clean and on its configured switch-back branch, and every PR body is human-readable without generated review/release-note blocks.",
  ];
}

export function buildLoopTaskPolicyLines(workOrder: LoopWorkOrder, baseBranch: string): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind === "pull-request-review") return pullRequestReviewPolicy(workOrder, baseBranch);
  if (task.kind === "repository-pull-request-review")
    return repositoryPullRequestReviewPolicy(workOrder);
  if (task.kind === "workspace-architecture") return workspaceArchitecturePolicy(workOrder);
  if (task.kind === "active-delegated-task") return activeDelegatedTaskPolicy(workOrder);
  if (task.kind === "opportunity-discovery") return opportunityDiscoveryPolicy(workOrder);
  if (task.kind === "automation-governance-review")
    return automationGovernanceReviewPolicy(workOrder);
  if (task.kind === "test-coverage") return testCoveragePolicy(workOrder);
  if (task.kind === "security-maintenance") return securityMaintenancePolicy(workOrder);
  if (task.kind === "bug-fix") return bugFixPolicy(workOrder);
  if (task.kind === "harness-auto") return harnessAutoPolicy(workOrder);
  return architecturePolicy(workOrder);
}

function workOrderTask(workOrder: LoopWorkOrder): LoopWorkOrderTask {
  return workOrder.task ?? { kind: "architecture" };
}

function architecturePolicy(workOrder: LoopWorkOrder): string[] {
  return [
    "- Work in focused rounds and stop at the configured limits.",
    `- Architecture target score is ${workOrder.targetScore}; if evaluation reaches or exceeds it, stop instead of optimizing for its own sake.`,
    ...cleanupPolicyLines(effectiveCleanupPolicy(workOrder.cleanupPolicy)),
  ];
}

function workspaceArchitecturePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "workspace-architecture" || workOrder.workspace === undefined) return [];
  return [
    "Workspace architecture task.",
    `- Architecture target score is ${workOrder.targetScore}; if the cross-repository evaluation reaches or exceeds it, stop instead of optimizing for its own sake.`,
    "- Use native exploration to compare repository roles and contracts when useful, then synthesize one workspace-level decision with evidence and uncertainty.",
    "- Prefer the smallest set of repository changes that improves the whole workspace. Do not force every repository to change.",
    ...cleanupPolicyLines(effectiveCleanupPolicy(workOrder.cleanupPolicy)),
    task.prompt !== undefined ? `- Additional workspace instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function bugFixPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "bug-fix") return [];
  return [
    "Bug finding and repair task.",
    `- Run at most ${task.maxRounds} focused bug-fix round(s); each round may fix at most ${task.maxBugsPerRound} confirmed bug(s).`,
    "- Search for real bugs only: functional correctness, reliability, data/state consistency, missed or duplicate execution, wrong success/failure reporting, unsafe merge behavior, unhandled edge cases, security-sensitive mistakes, or user-visible regressions.",
    "- Audit through concrete risk lenses: money, quota, billing, permissions, privilege escalation, concurrency, transactions, data correctness, idempotency, scheduling/state machines, error-handling contracts, and cross-module or frontend/backend contracts.",
    "- Do not nitpick style, naming, wording, formatting, harmless refactors, architecture taste, or speculative concerns.",
    "- Do not add product features, new capabilities, new dependencies, broad rewrites, or unrelated cleanup.",
    ...cleanupPolicyLines(effectiveCleanupPolicy(task.cleanupPolicy ?? workOrder.cleanupPolicy)),
    "- Separate candidate bugs from confirmed bugs: list candidates first, then fix only candidates with enough evidence to confirm real impact.",
    "- Native parallel exploration may collect candidate bugs, but confirmation and repair must be evidence-chain driven and sequenced through the bounded WorkOrder.",
    "- For every confirmed bug, record a concise evidence chain: entry point or trigger, affected path, expected behavior, actual behavior, impact, and any preconditions or limits.",
    "- Before editing, prove the issue is real by recording the trigger path, affected behavior, and why it is not merely a preference or theoretical concern.",
    "- If the impact depends on another boundary layer, such as a caller, callee, API, worker, scheduler, database constraint, or frontend/backend pair, inspect that boundary before confirming the bug.",
    "- Before editing, perform an independent verification pass from the current final code state and calling path; if that pass cannot reconstruct the bug mechanism, skip the candidate.",
    "- If a suspected issue cannot be proven as a real functional or reliability risk, record it as a deferred candidate or skipped candidate and do not edit for it.",
    "- Keep each repair small, local, and consistent with existing project patterns.",
    task.requireRegressionTest
      ? "- Add or update a focused regression test for every code bug you fix. If a regression test is genuinely impossible, record the reason and use the narrowest available verification instead."
      : "- Prefer focused regression tests for fixed bugs, but follow the configured project verification contract when tests are impractical.",
    "- After each repair, independently re-check the same evidence chain: the original trigger path is blocked, expected behavior now holds, and the diff did not add feature work, unrelated refactors, or a new functional risk; then run the relevant checks.",
    "- When no confirmed bug is fixed, still report the checked areas, skipped areas, deferred candidates, and whether coverage was complete, partial, or unknown; zero fixes with partial coverage must not be presented as proof that the project has no bugs.",
    "- Stop when a round finds no confirmed real bugs; do not continue looking just because maxRounds remains.",
    task.prompt !== undefined ? `- Additional bug-fix instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function testCoveragePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "test-coverage") return [];
  return [
    "Test coverage improvement task.",
    `- Target effective test coverage is at least ${task.targetCoverage}%. Stop when the project reaches that threshold and the important risk paths have meaningful tests.`,
    `- Run at most ${task.maxRounds} focused test-improvement round(s). Each round must start by inspecting the current test stack, coverage command/report, uncovered behavior, and highest-risk production paths.`,
    "- Use native exploration to compare coverage gaps and risk paths when useful, then choose the highest-value behavior tests rather than padding metrics.",
    "- Add tests only when they assert real behavior or guard a plausible regression. Do not add import-only tests, empty assertions, mock implementation tests, snapshot padding, fixture churn, or tests whose only value is increasing a metric.",
    "- Do not add padding tests.",
    "- Tests must be professional, elegant, reliable, and clear: prefer stable assertions at meaningful boundaries, avoid brittle timing, avoid over-mocking implementation details, and keep fixtures readable.",
    "- Prefer focused unit tests for deterministic domain logic and edge cases. Add integration, smoke, E2E, or AI eval tests only when the project shape and risk justify them.",
    task.allowIntegrationTests
      ? "- Integration tests are allowed when they verify real module, API, persistence, queue, scheduler, or frontend/backend boundaries that unit tests cannot cover well."
      : "- Do not add integration tests for this task.",
    task.allowSmokeTests
      ? "- Smoke tests are allowed when they cheaply prove the app, CLI, worker, or service starts and the critical happy path is wired."
      : "- Do not add smoke tests for this task.",
    task.allowE2ETests
      ? "- E2E tests are allowed only for critical user-visible workflows whose risk cannot be covered reliably at lower levels."
      : "- Do not add E2E tests for this task.",
    task.allowAiEvalTests
      ? "- AI eval tests are allowed only when the project already has an agent-backed or deterministic eval surface; do not add direct model-provider API calls, model SDKs, or model API keys."
      : "- Do not add AI eval tests for this task.",
    task.requireMeaningfulTests
      ? "- Every added or changed test must have a clear behavior/risk statement in actionsTaken. If you cannot state the behavior it protects, do not keep the test."
      : "- Prefer meaningful behavior tests and record any metric-only exception explicitly.",
    "- If coverage is blocked because code is over-coupled or hard to exercise, make the smallest necessary refactor that improves testability without changing behavior, then test the extracted behavior.",
    "- If you discover a real bug, vulnerability, flaky behavior, broken test harness, or incorrect existing test while adding coverage, independently confirm it, fix it narrowly, and add a regression test when practical.",
    "- After each round, run the relevant test/coverage command and inspect the diff to confirm it did not add features, broad rewrites, brittle tests, or meaningless coverage.",
    "- If the project has no reliable unified coverage command, report that clearly, add the highest-value tests for critical paths, and use the narrowest available verification instead of inventing a fake coverage number.",
    ...cleanupPolicyLines(effectiveCleanupPolicy(task.cleanupPolicy ?? workOrder.cleanupPolicy)),
    task.prompt !== undefined ? `- Additional test-coverage instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function securityMaintenancePolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "security-maintenance") return [];
  return [
    "Security maintenance task.",
    `- Risk gate: action threshold ${task.actionThreshold}; critical threshold ${task.criticalThreshold}. The pre-dispatch assessment has already determined this run is actionable, but independently verify the finding before editing.`,
    "- Treat a critical finding or a confirmed risk at or above the action threshold as repairable; record lower-risk, unreachable, speculative, or false-positive findings as not-needed or follow-ups without changing code.",
    `- Run at most ${task.maxRounds} focused security round(s). Stop when no confirmed actionable security issue remains within this task's allowed scope.`,
    "- Check broadly for security risk, not only dependency advisories: dependency vulnerabilities, GitHub security findings, static analysis findings, secret or token exposure, unsafe auth/permission checks, webhook verification, CORS, file/path handling, uploads, deserialization/parsing, SSRF, command execution, logging of sensitive data, CI secret handling, and supply-chain risk.",
    "- Use native exploration to inspect independent security surfaces when useful, but repair only confirmed or plausibly reachable findings.",
    "- Start with the project's own security signals when available: npm/pnpm/yarn/bun audit, GitHub Dependabot/security alerts, CodeQL, Semgrep, ESLint security rules, existing CI/security scripts, and repository documentation.",
    "- Before editing, prove the issue is real or plausibly reachable in this project. Record the evidence, affected path, severity, reachability, and why it is not merely a scanner false positive.",
    "- Do not add product features, broad rewrites, cosmetic cleanup, speculative hardening, unrelated test coverage, or dependency churn just to quiet a report.",
    task.allowDependencyUpdates
      ? "- Dependency updates are allowed only when they address a confirmed security issue or safe supply-chain maintenance; prefer the smallest compatible update and inspect changelogs or release notes when risk is non-trivial."
      : "- Do not perform dependency updates; classify dependency findings and report blockers instead.",
    task.allowConfigHardening
      ? "- Config hardening is allowed when it directly reduces a confirmed exposure and preserves documented deployment behavior."
      : "- Do not change runtime, CI, or deployment configuration; classify config findings and report blockers instead.",
    task.allowStaticAnalysisFixes
      ? "- Static analysis fixes are allowed when they correct a real security-sensitive behavior or remove a high-signal finding without weakening checks."
      : "- Do not edit code solely for static analysis findings; report them with evidence and blockers.",
    "- For every fix, add or update a focused regression, smoke, or security test when practical. If a test is not practical, record the narrow verification command and manual reasoning.",
    "- After each fix, rerun the relevant security check plus the normal local verification required by the project, then inspect the diff for new security, compatibility, or operational risk.",
    "- PR content must clearly separate: finding source, severity/reachability judgment, fix, verification, and any accepted residual risk.",
    ...cleanupPolicyLines(effectiveCleanupPolicy(task.cleanupPolicy ?? workOrder.cleanupPolicy)),
    task.prompt !== undefined
      ? `- Additional security-maintenance instruction: ${task.prompt}`
      : "",
  ].filter(Boolean);
}

function harnessAutoPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "harness-auto") return [];
  const enabledTasks = task.tasks.filter((subtask) => subtask.enabled);
  return [
    "Harness-auto health orchestration task.",
    `- Run at most ${task.maxRounds} harness round(s). Each harness round starts with a fresh project health assessment, then chooses the highest-value enabled subtask(s) for that current state.`,
    `- Strategy is ${task.strategy}. health-first means maximize overall project health; risk-first means prioritize confirmed production/security/reliability risk; configured-order means preserve the configured task order unless current evidence clearly proves a blocker.`,
    `- Stop when health score is at least ${task.stopWhen.healthScoreAtLeast}${task.stopWhen.noConfirmedIssues ? " and no confirmed actionable issue remains in the enabled task scope" : ""}.`,
    "- Do not run all subtasks mechanically. Choose only subtasks justified by evidence from the current codebase and verification signals.",
    "- Use assessment-first worker reasoning: native subagents or parallel exploration may inform selection, but tmux-claude-bot must still produce one bounded WorkOrder result.",
    "- Do not start multiple bot-managed mutation workers for child subtasks.",
    "- Start each round by recording: current branch state, recent failures or stale PR context, available test/security/coverage/architecture signals, candidate issues, enabled subtasks considered, selected subtask(s), and why lower-priority subtasks were skipped.",
    "- A no-op is valid when the stop condition is met or no enabled subtask has a confirmed actionable improvement. Report the checked signals and stop cleanly instead of optimizing for its own sake.",
    "- Keep the whole harness run on one run id and one PR branch/PR per repository. Do not split bug-fix, security, coverage, and architecture work into separate PRs for the same harness run.",
    "- If multiple subtasks touch the same area, sequence them deliberately: fix confirmed bugs/security issues first, add or update regression/coverage tests next, then make architecture cleanup only when the behavior is protected.",
    "- Before each edit, prove the selected subtask has a real reason. After each edit, re-check the exact evidence chain and run the narrowest relevant verification plus the normal project verification when available.",
    "- PR content must clearly list the harness assessment, selected subtasks, skipped subtasks with reasons, changes made, verification, remaining risk, and stop condition result.",
    ...cleanupPolicyLines(effectiveCleanupPolicy(task.cleanupPolicy ?? workOrder.cleanupPolicy)),
    `- Enabled subtasks: ${enabledTasks.map((subtask) => `${subtask.kind}(weight=${subtask.weight})`).join(", ") || "none"}.`,
    task.prompt !== undefined ? `- Additional harness-auto instruction: ${task.prompt}` : "",
    ...harnessSubtaskPolicies(workOrder, enabledTasks),
  ].filter(Boolean);
}

function opportunityDiscoveryPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "opportunity-discovery") return [];
  const reportPath =
    workOrder.opportunityReportPath ?? opportunityReportPath(workOrder.projectId, workOrder.id);
  return [
    "Opportunity discovery task.",
    "- This task must discover and propose valuable opportunities only; do not edit files, commit, push, create branches, create PRs, or change project state.",
    "- Think like a senior employee proposing focused work to the owner: surface decisions, not busywork.",
    `- Produce at most ${task.maxSuggestions} suggestion(s). Fewer is better when the evidence is weak.`,
    `- Minimum confidence is ${task.minConfidence}; do not include lower-confidence ideas.`,
    `- Allowed categories: ${task.categories.join(", ")}.`,
    task.requireEvidence
      ? "- Every suggestion must cite concrete evidence from the repository, docs, logs, recent failures, TODOs, repeated manual workflows, tests, scripts, or existing UX. Do not invent product direction."
      : "- Prefer concrete evidence; clearly label any suggestion whose evidence is incomplete.",
    "- Use broad native exploration when useful, then synthesize each suggestion with evidence, uncertainty, confidence, and the recommended next step.",
    "- A suggestion is reportable only when it has a clear user or engineering value, bounded implementation scope, acceptance criteria, non-goals, and a realistic verification path.",
    "- Avoid vague ideas, vanity features, broad rewrites, large product pivots, purely stylistic cleanup, speculative architecture preferences, or suggestions whose only value is making code look different.",
    "- Prefer small or medium opportunities that can be implemented by a later active delegated task in one coherent PR.",
    "- Include simple options or alternatives when useful, but mark one recommended approach.",
    "- The owner will decide whether to discuss or delegate. Do not start implementation in this WorkOrder.",
    `- Write the opportunity report JSON to ${shellQuote(reportPath)} before finalizing.`,
    "- The JSON file must contain exactly: projectId, projectName, generatedAt, coverage, checkedSignals, skippedSignals, suggestions.",
    '- coverage must be one of "complete", "partial", or "unknown".',
    "- suggestions must be an array of objects with: title, category, confidence, problem, whyNow, value, evidence, recommendedApproach, alternatives, acceptanceCriteria, risks, nonGoals, estimatedComplexity, delegateRequirement.",
    '- category must be one of "product-feature", "workflow-automation", "developer-experience", "reliability", "architecture", "testing", "security".',
    '- confidence must be one of "low", "medium", "high"; estimatedComplexity must be one of "small", "medium", "large".',
    "- delegateRequirement must be the clear implementation brief that will be handed to /autopilot delegate after owner approval.",
    task.prompt !== undefined
      ? `- Additional opportunity-discovery instruction: ${task.prompt}`
      : "",
  ].filter(Boolean);
}

function automationGovernanceReviewPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "automation-governance-review") return [];
  const governance = workOrder.governance;
  return [
    "Automation governance review task.",
    "- Review tmux-claude-bot's own automation governance, not target-project product logic.",
    "- Focus on task taxonomy, WorkOrder prompts, system gates, scheduler and ledger evidence, notification visibility, Runtime Guardian and Daily Task Audit boundaries, AI/eval policy, and merge discipline.",
    `- Target governance score is at least ${task.targetScore}; stop when the evidence reaches that score instead of optimizing beyond the bounded task.`,
    `- Report at most ${task.maxFindings} concrete governance finding(s), ordered by severity.`,
    task.requireAiEval
      ? "- Agent-backed AI eval may be used through the existing Claude Code / Codex control surface only; deterministic gates remain authoritative."
      : "- AI eval is optional; deterministic gates remain authoritative.",
    "- Do not call model-provider APIs, add model SDKs, or add model API keys.",
    "- Before editing, prove the governance issue is real from scheduler config, ledger records, supervisor artifacts, notification artifacts, CI/system gates, or repository code.",
    "- You may review governance surfaces as separate perspectives inside the active worker, but do not create bot-managed evaluator or researcher roles.",
    task.allowRepairPr
      ? "- You may create a repair PR or update one repair PR only for a concrete P0/P1 (P0 or P1) governance finding; do not create repair PRs for P2/P3 findings."
      : "- Do not create repair PRs; report findings only.",
    "- Governance repair PRs must not be auto-merged; if you create a repair PR, do not merge it.",
    "- If a repair PR is created or updated, include pullRequestDecisions[] in the final summary with severity P0, P1, P2, or P3.",
    governance === undefined
      ? ""
      : `- Structured governance policy: scope=${governance.scope}; allowPullRequest=${governance.repair.allowPullRequest}; autoMerge=${governance.repair.autoMerge}; minimumSeverity=${governance.repair.minimumSeverity}; maxPullRequests=${governance.repair.maxPullRequests}.`,
    task.prompt !== undefined
      ? `- Additional automation-governance-review instruction: ${task.prompt}`
      : "",
  ].filter(Boolean);
}

function harnessSubtaskPolicies(
  workOrder: LoopWorkOrder,
  enabledTasks: HarnessAutoSubtask[],
): string[] {
  const sections: string[] = [];
  for (const subtask of enabledTasks) {
    const pseudoWorkOrder = workOrderForHarnessSubtask(workOrder, subtask);
    if (subtask.kind === "architecture") {
      sections.push(
        "Harness subtask policy: architecture.",
        ...(workOrder.workspace === undefined
          ? architecturePolicy(pseudoWorkOrder)
          : workspaceArchitecturePolicy(pseudoWorkOrder)),
      );
    } else if (subtask.kind === "bug-fix") {
      sections.push("Harness subtask policy: bug-fix.", ...bugFixPolicy(pseudoWorkOrder));
    } else if (subtask.kind === "test-coverage") {
      sections.push(
        "Harness subtask policy: test-coverage.",
        ...testCoveragePolicy(pseudoWorkOrder),
      );
    } else {
      sections.push(
        "Harness subtask policy: security-maintenance.",
        ...securityMaintenancePolicy(pseudoWorkOrder),
      );
    }
  }
  return sections;
}

function workOrderForHarnessSubtask(
  workOrder: LoopWorkOrder,
  subtask: HarnessAutoSubtask,
): LoopWorkOrder {
  if (subtask.kind === "architecture") {
    return {
      ...workOrder,
      cleanupPolicy: effectiveCleanupPolicy(subtask.cleanupPolicy),
      task:
        workOrder.workspace === undefined
          ? { kind: "architecture" }
          : {
              kind: "workspace-architecture",
              ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
            },
      targetScore: subtask.targetScore,
      maxRounds: subtask.maxRounds,
    };
  }
  return {
    ...workOrder,
    cleanupPolicy: effectiveCleanupPolicy(subtask.cleanupPolicy),
    task: harnessSubtaskAsWorkOrderTask(subtask),
    maxRounds: subtask.maxRounds,
  };
}

function harnessSubtaskAsWorkOrderTask(
  subtask: Exclude<HarnessAutoSubtask, { kind: "architecture" }>,
): LoopWorkOrderTask {
  if (subtask.kind === "bug-fix") {
    return {
      kind: "bug-fix",
      maxRounds: subtask.maxRounds,
      maxBugsPerRound: subtask.maxBugsPerRound,
      requireRegressionTest: subtask.requireRegressionTest,
      cleanupPolicy: effectiveCleanupPolicy(subtask.cleanupPolicy),
      ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
    };
  }
  if (subtask.kind === "test-coverage") {
    return {
      kind: "test-coverage",
      targetCoverage: subtask.targetCoverage,
      maxRounds: subtask.maxRounds,
      requireMeaningfulTests: subtask.requireMeaningfulTests,
      allowIntegrationTests: subtask.allowIntegrationTests,
      allowSmokeTests: subtask.allowSmokeTests,
      allowE2ETests: subtask.allowE2ETests,
      allowAiEvalTests: subtask.allowAiEvalTests,
      cleanupPolicy: effectiveCleanupPolicy(subtask.cleanupPolicy),
      ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
    };
  }
  return {
    kind: "security-maintenance",
    maxRounds: subtask.maxRounds,
    actionThreshold: subtask.actionThreshold,
    criticalThreshold: subtask.criticalThreshold,
    allowDependencyUpdates: subtask.allowDependencyUpdates,
    allowConfigHardening: subtask.allowConfigHardening,
    allowStaticAnalysisFixes: subtask.allowStaticAnalysisFixes,
    cleanupPolicy: effectiveCleanupPolicy(subtask.cleanupPolicy),
    ...(subtask.prompt !== undefined ? { prompt: subtask.prompt } : {}),
  };
}

function pullRequestReviewPolicy(workOrder: LoopWorkOrder, baseBranch: string): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "pull-request-review") return [];
  if (workOrder.workspace !== undefined) {
    const repositories = workOrder.workspace.repositories
      .filter((repository) => repository.pullRequest.enabled)
      .map(
        (repository) =>
          `${repository.id}(${repository.pullRequest.base}->${repository.pullRequest.switchBack}, autoMerge=${repository.pullRequest.autoMerge})`,
      )
      .join(", ");
    return [
      "Workspace pull request review and merge task.",
      `- Review open loop-created PRs across this workspace's PR-enabled repositories: ${repositories || "none"}.`,
      "- Treat loop-created PRs as PRs whose head branch starts with loop/ or whose title/body clearly identifies Loop Engineering.",
      `- Prioritize PRs created or updated within the last ${task.lookbackHours} hours, but inspect every open PR before finalizing; age, Draft state, or conflict state is not a reason to omit a decision.`,
      `- Run two independent review passes for each candidate PR. Merge only when ${task.consecutivePasses} consecutive passes find no bug, CI, mergeability, data loss, security, migration, dependency, deployment, or user-visible regression risk.`,
      "- Do not nitpick style, naming, wording, formatting, or harmless refactors. Focus on whether the PR introduced a real bug or operational risk.",
      "- Inspect each repository's PR diff, files changed, commits, review comments, mergeability, and CI/status checks before deciding.",
      "- Draft is a review state, not an exclusion: inspect same-repository draft PRs, then either make the bounded repair and run `gh pr ready <number>` before re-reviewing, or run `gh pr close <number> --comment <reason>` for obsolete/duplicate/non-actionable work; leave it open only with a concrete human decision blocker.",
      "- For a same-repository conflicting PR, take over the existing head branch, sync the configured base, resolve the conflict when it is safe and bounded, push, and repeat the review/check gates; if it is obsolete or non-actionable, close it with evidence, otherwise record the exact human blocker. Do not silently skip it.",
      "- If checks are pending, inconclusive, failing, required reviews are missing, mergeability is unknown, or the branch is behind in a way GitHub cannot update safely, record the exact blocker and decide whether to repair, close, or request human action.",
      "- The review passes may use the worker agent's native review capabilities, but merge decisions remain serialized and gated by PR, CI, mergeability, and system evidence.",
      task.autoMerge
        ? "- If both review passes pass and CI/status checks are successful, merge the PR according to that repository's pullRequest policy, including its configured mergeMethod, then sync the repository's local switch-back branch."
        : "- Do not merge automatically; report the review decision only.",
      '- Final status may be "completed" only after every in-scope workspace PR has a recorded review decision.',
      task.prompt !== undefined ? `- Additional review instruction: ${task.prompt}` : "",
    ].filter(Boolean);
  }
  return [
    "Pull request review and merge task.",
    `- Review open loop-created PRs for this repository targeting ${baseBranch}, prioritizing PRs created or updated within the last ${task.lookbackHours} hours while still inspecting every open PR before finalizing.`,
    "- Treat loop-created PRs as PRs whose head branch starts with loop/ or whose title/body clearly identifies Loop Engineering.",
    `- Run two independent review passes for each candidate PR. Merge only when ${task.consecutivePasses} consecutive passes find no bug, CI, mergeability, data loss, security, migration, or user-visible regression risk.`,
    "- Do not nitpick style, naming, wording, or harmless refactors. Focus on whether the PR introduced a real bug or operational risk.",
    "- Inspect the PR diff, files changed, commits, mergeability, and CI/status checks before deciding.",
    "- Draft is a review state, not an exclusion: inspect same-repository draft PRs, then either make the bounded repair and run `gh pr ready <number>` before re-reviewing, or run `gh pr close <number> --comment <reason>` for obsolete/duplicate/non-actionable work; leave it open only with a concrete human decision blocker.",
    "- For a same-repository conflicting PR, take over the existing head branch, sync the configured base, resolve the conflict when it is safe and bounded, push, and repeat the review/check gates; if it is obsolete or non-actionable, close it with evidence, otherwise record the exact human blocker. Do not silently skip it.",
    "- If checks are pending, inconclusive, failing, or mergeability is unknown, record the exact blocker and decide whether to repair, close, or request human action.",
    "- The review passes may use the worker agent's native review capabilities, but merge decisions remain serialized and gated by PR, CI, mergeability, and system evidence.",
    task.autoMerge
      ? `- If both review passes pass and CI/status checks are successful, merge the PR with GitHub CLI using ${mergeMethodFlag(task.mergeMethod)}, then sync the local switch-back branch.`
      : "- Do not merge automatically; report the review decision only.",
    task.prompt !== undefined ? `- Additional review instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function repositoryPullRequestReviewPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "repository-pull-request-review") return [];
  const scope = task.base === undefined ? "all base branches" : `base branch ${task.base}`;
  const listCommand =
    task.base === undefined
      ? `gh pr list --repo ${task.repo} --state open --limit 100 --json number,title,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,updatedAt,url,labels`
      : `gh pr list --repo ${task.repo} --state open --base ${task.base} --limit 100 --json number,title,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,updatedAt,url,labels`;
  return [
    "Repository pull request review and merge task.",
    `- Review every open pull request in ${task.repo} for ${scope}.`,
    `- At the start and immediately before final summary, list open PRs with: ${listCommand}.`,
    "- In actionsTaken, record the open PR count and each in-scope PR number/base/head/decision. If any PR is out of scope, record the explicit reason.",
    '- In the final JSON, include pullRequestDecisions with one entry for every in-scope PR. Each entry must contain number, repository, outcome, evidence, and nextStep. Outcomes are only "merged", "closed", "approved", "retry", or "manual-review". Use "approved" only when the PR diff, code behavior, tests, CI/checks, mergeability, security, data, dependency, deployment, and user-visible risk review passed but the PR still needs a system-owned state transition such as marking a Draft ready; approved entries must include reviewedHeadSha set to the exact reviewed PR head SHA. A manual-review entry must additionally contain exactly one structured boundary code: "ownership", "protected-branch-policy", "product-decision", "migration-decision", "security-decision", "legal-compliance", or "organization-policy"; never attach boundary to another outcome.',
    '- Use "closed" only for a clearly duplicate, obsolete, non-actionable, or invalid PR, and include exactly one reason from that allowlist plus evidence. Draft, conflict, age, or failed checks alone are never close reasons.',
    '- Use "retry" for pending checks, transient CI/network/worker failures, bounded repair still needed, incomplete review evidence, or a GitHub workflow conclusion of action_required that the configured account may be able to repair. Treat action_required, supported workflow approval, safe private-fork workflow configuration, same-repository conflicts, pending checks, and transient GitHub failures as system-repairable; they are not permission boundaries by themselves. Use "manual-review" only for a concrete structured human boundary with the exact next step. Generic architecture/design review, diff size, conflict count, Draft state, or a request for an owner to inspect ordinary code is not a human boundary and must remain retryable.',
    `- Prioritize PRs created or updated within the last ${task.lookbackHours} hours, but inspect every open PR before finalizing; age, Draft state, or conflict state is not a reason to omit a decision.`,
    `- Run two independent review passes for each candidate PR. Merge only when ${task.consecutivePasses} consecutive passes find no bug, CI, mergeability, data loss, security, migration, dependency, deployment, or user-visible regression risk.`,
    "- Do not nitpick style, naming, wording, formatting, or harmless refactors. Focus on whether the PR introduced a real bug or operational risk.",
    "- Inspect each PR diff, files changed, commits, review comments, mergeability, and CI/status checks before deciding.",
    "- Draft is a review state, not an exclusion: for a same-repository draft PR, inspect it and either make the bounded repair and run `gh pr ready <number>` before re-reviewing, or run `gh pr close <number> --comment <reason>` for obsolete/duplicate/non-actionable work; leave it open only with a concrete human decision blocker.",
    "- For a same-repository conflicting PR, take over the existing head branch, sync the configured base, resolve the conflict when it is safe and bounded, push, and repeat the review/check gates; if it is obsolete or non-actionable, close it with evidence, otherwise record the exact human blocker. Do not silently skip it.",
    "- If checks are pending, inconclusive, failing, required reviews are missing, mergeability is unknown, or the branch is behind in a way GitHub cannot update safely, record the exact blocker and decide whether to repair, close, or request human action.",
    "- A stale cancelled or superseded check run is not by itself a human blocker: compare runs for the same required check, rerun the exact workflow once when the latest result is inconclusive, then poll and re-read GitHub's current mergeability before deciding retry versus manual-review.",
    "- The review passes may use the worker agent's native review capabilities, but merge decisions remain serialized and gated by PR, CI, mergeability, and system evidence.",
    "- When polling after a repair push or merge attempt, always request PR state and mergedAt in addition to mergeability and checks. If GitHub reports state=MERGED, stop waiting on mergeability, verify checks and local switch-back state, then write the final summary.",
    ...repositoryPullRequestRepairPolicy(task),
    task.autoMerge
      ? `- If both review passes pass and CI/status checks are successful, merge the PR with GitHub CLI using ${mergeMethodFlag(task.mergeMethod)}, then sync the local switch-back branch.`
      : "- Do not merge automatically; report the review decision only.",
    task.autoMerge
      ? '- Final status must be "completed" only when every pullRequestDecisions entry is merged or explicitly closed with an evidence-backed allowlisted reason. If any entry is retry or manual-review, do not claim completed; retryable entries are requeued by the service and manual-review entries are retained for the owner.'
      : '- Final status may be "completed" only after every in-scope open PR has a recorded review decision.',
    task.prompt !== undefined ? `- Additional review instruction: ${task.prompt}` : "",
  ].filter(Boolean);
}

function repositoryPullRequestRepairPolicy(
  task: Extract<LoopWorkOrderTask, { kind: "repository-pull-request-review" }>,
): string[] {
  if (!task.repair.enabled || task.repair.maxAttempts === 0) {
    return ["- Do not modify PR branches; report blockers only."];
  }
  return [
    `- If a PR has only small, low-risk, clearly fixable issues, you may make at most ${task.repair.maxAttempts} repair attempt(s) on the PR's original head branch, then push that same branch and re-check the PR before considering merge.`,
    "- Repair is allowed only for same-repository branches that this GitHub account can push to. Do not modify external fork PRs.",
    "- Before repairing, inspect the PR head ref and confirm the branch is not protected, not marked do-not-merge, and safe to push. Draft status is not a repair exclusion.",
    "- A same-repository conflicting PR is repairable when the base sync and resolution are bounded and reviewable, including ordinary source, test, dependency, or lockfile conflicts. If resolution needs product, migration, security, or broad design judgment, decide whether the PR is obsolete and should be closed; otherwise leave a concrete human blocker.",
    "- If the only blocker is that a same-repository PR branch is behind the base branch, first prefer GitHub's safe branch update/rebase mechanism (for example gh pr update-branch when available); otherwise update the existing PR head branch with the base branch without creating a new PR branch, then rerun checks and both review passes.",
    "- Keep repairs limited to the introduced issue: formatting, type/lint/test failures, obvious missing import/export, straightforward dependency lock update, small test expectation correction, or a similarly bounded bug fix.",
    "- Do not repair issues that need product judgment, schema/data migration judgment, security design judgment, broad refactoring, public API redesign, or large dependency upgrades; record them as blockers.",
    "- To repair: fetch the PR head branch, switch to it, pull with rebase, apply the minimal fix, run the relevant failing checks plus the repository's normal local verification when available, review the diff, commit with a clear message, push to the PR head branch, then re-read PR status/checks/mergeability.",
    "- After a repair push, do not merge until CI/status checks have completed successfully and the review passes are repeated on the updated PR. If a reviewed draft is acceptable, explicitly run `gh pr ready <number>` before the final merge decision.",
    task.repair.prompt !== undefined
      ? `- Additional repair instruction: ${task.repair.prompt}`
      : "",
    "- Mandatory policy: Draft status and same-repository merge conflicts are active review states, not automatic human blockers; repair bounded conflicts and run `gh pr ready <number>` when appropriate. Only an explicit structured ownership, protected-branch policy, product, migration, security, legal/compliance, or organization-policy boundary may remain manual-review. The orchestration contract downgrades prose-only manual-review claims back to retry.",
  ].filter(Boolean);
}

function activeDelegatedTaskPolicy(workOrder: LoopWorkOrder): string[] {
  const task = workOrderTask(workOrder);
  if (task.kind !== "active-delegated-task") return [];
  const pullRequestPolicy =
    workOrder.pullRequestPolicy?.enabled === true ? workOrder.pullRequestPolicy : null;
  const projectManagedPr =
    workOrder.commitPolicy.enabled &&
    workOrder.commitPolicy.branch !== undefined &&
    pullRequestPolicy !== null;
  return [
    "Active delegated task.",
    `- This is a user-confirmed interactive task handed off from session ${task.sourceSession}; it is not a cron maintenance run.`,
    `- Requirement: ${task.requirement}`,
    ...(workOrder.executionIsolation?.sourceWorktree === undefined
      ? []
      : [
          `- The original user/session worktree is ${workOrder.executionIsolation.sourceWorktree}; treat paths in the delegated requirement that point there as source context only. Perform edits, commits, PR checks, and verification in the isolated expected worktree ${workOrder.projectPath}.`,
        ]),
    "Task advancement contract.",
    ...(workOrder.planning === undefined
      ? []
      : [
          "WorkOrder planning contract:",
          JSON.stringify(workOrder.planning, null, 2),
          "- Treat this planning contract as the minimum rubric; the delegationBrief may add evidence-specific detail but must not weaken it.",
        ]),
    "- Before substantive execution, create a concise delegationBrief from the requirement, current session context, and repository evidence. Keep it in actionsTaken or reviewGate.notes so the final run can be audited without reopening the worker transcript.",
    "- delegationBrief must include: objective, currentAssessment, currentScore when a meaningful score exists, targetScore when a meaningful target exists, taskChecklist, acceptanceCriteria, stopConditions, nonGoals, riskReview, and verificationPlan.",
    "- If the active agent surface supports a durable goal command, create or update that goal from the delegationBrief before execution. The WorkOrder remains the authoritative system contract; do not depend on a goal command as the only source of truth.",
    "- If the requirement is broad, ambiguous, high-risk, or the delegationBrief cannot define clear acceptance criteria and stopConditions, stop and report blocked or ask for owner clarification instead of guessing.",
    "- If the requirement is clear and bounded, use the delegationBrief as the execution checklist and proceed without adding a second confirmation gate.",
    "- Do not split this delegated task into parallel work unless the delegationBrief proves independent acceptance boundaries.",
    "- Treat the requirement as bounded. If the current session context is needed, inspect the target project with tcb peek/history or ask the target agent to summarize the agreed requirement before editing.",
    "- Drive the target project agent until the requested behavior is implemented or a real blocker is proven. Do not stop at a plan, partial implementation, or one failed check.",
    "- Work in explicit slices: confirm the intended behavior, implement the smallest coherent slice, run the relevant checks, review the diff, then continue to the next slice.",
    "- Preserve unrelated user work and do not introduce broad rewrites, new product scope, dependency churn, or direct model-provider integrations.",
    task.requireReview
      ? "- Before finalizing, perform an independent review pass focused on introduced bugs, behavior regressions, data loss, security, migration/config risk, and user-visible breakage; fix confirmed issues and repeat the review."
      : "- A final review pass is optional for this WorkOrder.",
    task.requireTests
      ? "- Run the target project's relevant tests or local verification. If no reliable test command exists, record the exact checked surface and why stronger verification is unavailable."
      : "- Tests are optional for this WorkOrder, but record any verification you do run.",
    task.requireCoverageReview
      ? "- Review test coverage for the touched behavior and risk paths. Add meaningful unit, integration, smoke, E2E, or regression tests where justified; do not add weak tests just to move a metric."
      : "- Coverage review is optional for this WorkOrder.",
    task.allowAiEval
      ? "- If the project already has an agent-backed or deterministic AI eval surface relevant to the touched behavior, run or update it when justified. Do not add direct model API calls, model SDKs, or model API keys."
      : "- Do not add or run AI eval work for this WorkOrder.",
    projectManagedPr
      ? workOrder.executionIsolation?.sourceWorktree === undefined
        ? `- This delegated task inherits the target project's PR policy: branch from ${pullRequestPolicy.base}, use ${workOrder.commitPolicy.branch}, open or update one PR against ${pullRequestPolicy.base}, verify CI and mergeability, ${pullRequestPolicy.autoMerge ? `allow auto-merge with ${mergeMethodFlag(pullRequestPolicy.mergeMethod)} only after all gates pass` : "leave the PR open after checks"}, then switch the local worktree back to ${pullRequestPolicy.switchBack} and rebase it onto origin/${pullRequestPolicy.switchBack}.`
        : `- This delegated task inherits the target project's PR policy: branch from ${pullRequestPolicy.base}, use ${workOrder.commitPolicy.branch}, open or update one PR against ${pullRequestPolicy.base}, verify CI and mergeability, ${pullRequestPolicy.autoMerge ? `allow auto-merge with ${mergeMethodFlag(pullRequestPolicy.mergeMethod)} only after all gates pass` : "leave the PR open after checks"}, then leave the isolated worker on the WorkOrder branch; the bot system owns source branch switch-back for ${pullRequestPolicy.switchBack} after acceptance.`
      : "- No project PR policy was matched for this delegated task; preserve the current branch and do not create commits or PRs unless the user requirement explicitly asks for it.",
    "- Before finalizing, record a planReview in actionsTaken or reviewGate.notes: checklistCompleted, targetScoreMet or not-applicable, stopConditionReached, overOptimizationAvoided, verificationCompleted, and remainingRisks.",
    "- Final status may be completed only after implementation, review, verification, and any justified coverage/eval work are done or explicitly recorded as not applicable.",
  ];
}

function cleanupPolicyLines(policy: LoopCleanupPolicy): string[] {
  if (policy === "aggressive") {
    return [
      "- Cleanup policy is aggressive: after confirming impact, actively remove obsolete compatibility paths, deprecated command aliases, duplicate entry points, stale transition code, and outdated documentation that conflict with the current feature boundary.",
      "- Aggressive cleanup still requires evidence: list the removed surface, why it has no supported user contract or current usage, the affected tests/docs checked, and the verification run after removal.",
    ];
  }
  if (policy === "balanced") {
    return [
      "- Cleanup policy is balanced: remove confirmed dead code, stale docs, and unsupported old paths when they create real confusion or maintenance risk; otherwise report them as cleanup candidates.",
      "- Do not remove a compatibility surface in balanced mode unless docs, commands, tests, and configured integrations prove it is not part of the supported contract.",
    ];
  }
  return [
    "- Cleanup policy is conservative: fix only the confirmed issue and directly related dead code; do not remove compatibility entry points, aliases, or old configuration paths unless they are proven unreachable and harmful.",
    "- In conservative mode, record broader cleanup ideas as deferred candidates instead of editing them.",
  ];
}

function effectiveCleanupPolicy(policy: LoopCleanupPolicy | undefined): LoopCleanupPolicy {
  return policy ?? "conservative";
}

function workspaceGithubPolicy(
  repository: NonNullable<LoopWorkOrder["workspace"]>["repositories"][number],
): string {
  const account = repository.pullRequest.githubAccount;
  if (account === undefined) return "use the repository's normal GitHub CLI identity";
  return `use command-local GitHub authentication via export GH_TOKEN="$(gh auth token --user ${shellQuote(account)})" before gh pr commands; do not rely on the global gh active account`;
}

function mergeMethodFlag(method: "squash" | "merge" | "rebase" | undefined): string {
  return `--${method ?? "squash"}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
