import type { ApprovedSkill } from "../skills/schema.js";
import type { LoopConfig, LoopProjectConfig } from "./config.js";

export type LoopRunCommandKind =
  | "preflight"
  | "assessment"
  | "agent"
  | "verification"
  | "eval"
  | "commit";

export type LoopRunCommandInvocation = {
  kind: LoopRunCommandKind;
  command: string;
  cwd: string;
  env: Record<string, string>;
};

export type LoopGitInvocation = {
  cwd: string;
  args: string[];
};

export type LoopRunCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type LoopRunCommandSummary = LoopRunCommandInvocation & LoopRunCommandResult;

export type LoopFinding = {
  id: string;
  title: string;
  action: string;
  confidence: string | number | null;
  autofixSafety: string | null;
  affectedFiles: string[];
  prompt: string;
  verificationCommands: string[];
};

export type LoopAgentEvalInvocation = {
  projectId: string;
  projectName: string;
  agent: LoopProjectConfig["agent"];
  cwd: string;
  prompt: string;
};

export type LoopAgentTaskInvocation = {
  projectId: string;
  projectName: string;
  agent: LoopProjectConfig["agent"];
  cwd: string;
  prompt: string;
  finding: LoopFinding;
};

export type LoopEvalResult = {
  passed: boolean;
  score: number | null;
  findings: unknown[];
  suggestedBotImprovements: string[];
};

export type LoopRoundSummary = {
  findingId: string;
  title: string;
  action: string;
  status: "skipped" | "executed" | "verified" | "committed" | "failed";
  reason?: string;
  verificationCommands: string[];
  commitSha?: string;
};

export type LoopRunSummary = {
  phase: "command-run";
  projectId: string;
  projectName: string;
  status: "passed" | "failed";
  executed: number;
  committed: boolean;
  rounds: LoopRoundSummary[];
  commands: LoopRunCommandSummary[];
  evalResult: LoopEvalResult | null;
  skills: {
    approved: ApprovedSkill[];
  };
  suggestedBotImprovements: string[];
};

type AssessmentResult = {
  score: number | null;
  findings: LoopFinding[];
  suggestedBotImprovements: string[];
};

function findProject(config: LoopConfig, projectId: string): LoopProjectConfig {
  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new Error(`unknown loop project "${projectId}"`);
  return project;
}

function envForProject(project: LoopProjectConfig): Record<string, string> {
  return {
    LOOP_PROJECT_ID: project.id,
    LOOP_PROJECT_NAME: project.name,
    LOOP_PROJECT_AGENT: project.agent,
    LOOP_PROJECT_GOAL: project.goal,
    LOOP_PROJECT_TARGET_SCORE: String(project.targetScore),
    LOOP_PROJECT_MAX_ROUNDS: String(project.maxRounds),
  };
}

function commandForAssessment(project: LoopProjectConfig): string {
  if (project.assessment.command === undefined) {
    throw new Error(`loop project "${project.id}" requires assessment.command`);
  }
  return project.assessment.command;
}

function buildAgentEvalPrompt(
  project: LoopProjectConfig,
  commands: LoopRunCommandSummary[],
): string {
  return [
    "Evaluate this Loop Engineering run using the current active agent surface.",
    `Project: ${project.name}`,
    `Project id: ${project.id}`,
    `Path: ${project.path}`,
    `Target score: ${project.targetScore}`,
    project.eval?.minScore !== undefined ? `Minimum excellent score: ${project.eval.minScore}` : "",
    `Goal: ${project.goal}`,
    "Commands:",
    ...commands.map((command) => `- ${command.kind}: exit ${command.status}`),
    "Return strict JSON with: passed, score, findings, suggestedBotImprovements.",
    "Do not request or use model-provider API keys.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAgentTaskPrompt(project: LoopProjectConfig, finding: LoopFinding): string {
  return [
    "Loop Engineering execution task.",
    `Project: ${project.name}`,
    `Project id: ${project.id}`,
    `Path: ${project.path}`,
    `Goal: ${project.goal}`,
    "",
    `Finding: ${finding.title}`,
    `Action: ${finding.action}`,
    `Affected files: ${finding.affectedFiles.join(", ")}`,
    "",
    finding.prompt,
    "",
    "Constraints:",
    "- Make only the focused change required by this finding.",
    "- Use the currently running Claude Code / Codex capability only.",
    "- Do not add model-provider SDKs, API-key env vars, or direct model HTTP calls.",
    "- Keep the change small enough to verify in this run.",
    "",
    "Verification commands the loop runner will execute after this task:",
    ...finding.verificationCommands.map((command) => `- ${command}`),
  ].join("\n");
}

function syntheticFinding(input: {
  id: string;
  title: string;
  prompt: string;
  verificationCommands?: string[];
}): LoopFinding {
  return {
    id: input.id,
    title: input.title,
    action: "small-refactor",
    confidence: "high",
    autofixSafety: "guarded",
    affectedFiles: [],
    prompt: input.prompt,
    verificationCommands: input.verificationCommands ?? [],
  };
}

function buildPreflightRepairPrompt(
  project: LoopProjectConfig,
  failed: LoopRunCommandSummary[],
): string {
  return [
    "Loop Engineering preflight failed before architecture work started.",
    `Project: ${project.name}`,
    `Project id: ${project.id}`,
    `Path: ${project.path}`,
    "",
    project.preflight.repair.prompt ??
      "Repair this project's local environment using its own setup docs and scripts.",
    "",
    "Failed preflight commands:",
    ...failed.map((command) =>
      [
        `- ${command.command}`,
        command.stderr.trim() ? `  stderr: ${command.stderr.trim()}` : "",
        command.stdout.trim() ? `  stdout: ${command.stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "Constraints:",
    "- Do not start the architecture refactor.",
    "- Do not change verification commands to bypass project rules.",
    "- Do not add model-provider SDKs, API-key env vars, or direct model HTTP calls.",
    "- Report the commands run and the smallest remaining blocker if repair fails.",
  ].join("\n");
}

function buildDirtyWorktreeRecoveryPrompt(project: LoopProjectConfig, status: string): string {
  return [
    "Loop Engineering found a dirty worktree before starting a new scheduled slice.",
    `Project: ${project.name}`,
    `Project id: ${project.id}`,
    `Path: ${project.path}`,
    "",
    "Do not start a new architecture scan. Finish or safely resolve the existing failed slice.",
    "Run the project-appropriate verification gates, then commit the focused slice if all gates pass.",
    "If the changes are not safe to keep, stop and report the exact blocker instead of overwriting user work.",
    "",
    "Current git status --porcelain:",
    status.trim(),
    "",
    "Constraints:",
    "- Keep the recovery focused on the existing worktree changes.",
    "- Do not change runtime contracts, secrets, deployment settings, or model integrations.",
    "- Do not add model-provider SDKs, API-key env vars, or direct model HTTP calls.",
  ].join("\n");
}

function buildVerificationRecoveryPrompt(input: {
  project: LoopProjectConfig;
  finding: LoopFinding;
  failed: LoopRunCommandSummary;
  attempt: number;
}): string {
  return [
    "Loop Engineering verification failed after the agent changed the worktree.",
    `Project: ${input.project.name}`,
    `Project id: ${input.project.id}`,
    `Path: ${input.project.path}`,
    "",
    `Finding: ${input.finding.title}`,
    `Recovery attempt: ${input.attempt}`,
    "",
    "Fix only the current failed slice, then stop. Do not start a new architecture scan.",
    "",
    "Failed verification command:",
    input.failed.command,
    input.failed.stderr.trim() ? `stderr:\n${input.failed.stderr.trim()}` : "",
    input.failed.stdout.trim() ? `stdout:\n${input.failed.stdout.trim()}` : "",
    "",
    "Verification commands the loop runner will retry after this recovery task:",
    ...input.finding.verificationCommands.map((command) => `- ${command}`),
    "",
    "Constraints:",
    "- Keep the change focused on this finding.",
    "- Do not bypass the gate by changing verification commands.",
    "- Do not add model-provider SDKs, API-key env vars, or direct model HTTP calls.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  if (stdout.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeFinding(raw: unknown, index: number): LoopFinding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const action = typeof record.action === "string" ? record.action.trim() : "";
  const prompt =
    typeof record.prompt === "string" && record.prompt.trim().length > 0
      ? record.prompt.trim()
      : title;
  if (title.length === 0 || action.length === 0 || prompt.length === 0) return null;
  const id =
    typeof record.id === "string" && record.id.trim().length > 0
      ? record.id.trim()
      : `finding-${index + 1}`;
  const confidence =
    typeof record.confidence === "string" || typeof record.confidence === "number"
      ? record.confidence
      : null;
  const autofixSafety =
    typeof record.autofixSafety === "string"
      ? record.autofixSafety
      : typeof record.safety === "string"
        ? record.safety
        : null;
  return {
    id,
    title,
    action,
    confidence,
    autofixSafety,
    affectedFiles: stringArray(record.affectedFiles),
    prompt,
    verificationCommands: stringArray(record.verificationCommands),
  };
}

function parseAssessmentResult(stdout: string): AssessmentResult {
  const record = parseJsonObject(stdout);
  if (record === null) {
    return { score: null, findings: [], suggestedBotImprovements: [] };
  }
  return {
    score: typeof record.score === "number" ? record.score : null,
    findings: Array.isArray(record.findings)
      ? record.findings
          .map((finding, index) => normalizeFinding(finding, index))
          .filter((finding): finding is LoopFinding => finding !== null)
      : [],
    suggestedBotImprovements: stringArray(record.suggestedBotImprovements),
  };
}

function parseEvalResult(stdout: string): LoopEvalResult | null {
  const record = parseJsonObject(stdout);
  if (record === null) return null;
  return {
    passed: record.passed === true,
    score: typeof record.score === "number" ? record.score : null,
    findings: Array.isArray(record.findings) ? record.findings : [],
    suggestedBotImprovements: stringArray(record.suggestedBotImprovements),
  };
}

function commandSummary(
  invocation: LoopRunCommandInvocation,
  result: LoopRunCommandResult,
): LoopRunCommandSummary {
  return {
    ...invocation,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function skippedRound(finding: LoopFinding, reason: string): LoopRoundSummary {
  return {
    findingId: finding.id,
    title: finding.title,
    action: finding.action,
    status: "skipped",
    reason,
    verificationCommands: finding.verificationCommands,
  };
}

function confidenceIsHigh(confidence: LoopFinding["confidence"]): boolean {
  if (typeof confidence === "number") return confidence >= 0.8;
  if (typeof confidence !== "string") return false;
  return ["high", "safe", "strong"].includes(confidence.toLowerCase());
}

function safetyAllowsAutofix(safety: string | null): boolean {
  if (safety === null) return false;
  return ["safe", "guarded", "low-risk", "low"].includes(safety.toLowerCase());
}

function planningBlockReason(project: LoopProjectConfig, finding: LoopFinding): string | null {
  const hardBlocked = new Set<string>([
    ...project.blockedActions,
    "direct-model-api",
    "dependency-upgrade",
    "broad-rewrite",
  ]);
  if (hardBlocked.has(finding.action)) return `blocked action: ${finding.action}`;
  if (
    project.allowedActions.length > 0 &&
    !project.allowedActions.includes(finding.action as never)
  ) {
    return `action not allowed: ${finding.action}`;
  }
  if (!confidenceIsHigh(finding.confidence)) return "confidence is not high enough";
  if (!safetyAllowsAutofix(finding.autofixSafety)) return "autofix safety is not safe enough";
  if (finding.affectedFiles.length === 0) return "affectedFiles is required";
  if (finding.action !== "docs" && finding.verificationCommands.length === 0) {
    return "verificationCommands is required";
  }
  return null;
}

function planFindings(
  project: LoopProjectConfig,
  findings: LoopFinding[],
): { selected: LoopFinding[]; skipped: LoopRoundSummary[] } {
  const selected: LoopFinding[] = [];
  const skipped: LoopRoundSummary[] = [];
  for (const finding of findings) {
    const reason = planningBlockReason(project, finding);
    if (reason !== null) {
      skipped.push(skippedRound(finding, reason));
      continue;
    }
    if (selected.length < project.maxRounds) {
      selected.push(finding);
      continue;
    }
    skipped.push(skippedRound(finding, "maxRounds limit reached"));
  }
  return { selected, skipped };
}

function gitCommandSummary(
  cwd: string,
  args: string[],
  result: LoopRunCommandResult,
): LoopRunCommandSummary {
  return commandSummary(
    {
      kind: "commit",
      command: `git ${args.join(" ")}`,
      cwd,
      env: {},
    },
    result,
  );
}

function commandPassed(command: LoopRunCommandSummary): boolean {
  if (command.status === 0) return true;
  if (command.kind === "preflight" || command.kind === "verification") return true;
  return (
    command.kind === "commit" &&
    command.command === "git diff --cached --quiet" &&
    command.status === 1
  );
}

function preflightCommands(project: LoopProjectConfig): string[] {
  return project.preflight.commands;
}

function finalStatus(
  commands: LoopRunCommandSummary[],
  rounds: LoopRoundSummary[],
  evalResult: LoopEvalResult | null,
  minScore: number | undefined,
): "passed" | "failed" {
  const commandsPassed = commands.every(commandPassed);
  const roundsPassed = rounds.every((round) => round.status !== "failed");
  const evalPassed =
    evalResult === null
      ? true
      : evalResult.passed && (minScore === undefined || (evalResult.score ?? -1) >= minScore);
  return commandsPassed && roundsPassed && evalPassed ? "passed" : "failed";
}

function completeSummary(input: {
  project: LoopProjectConfig;
  approvedSkills: ApprovedSkill[];
  commands: LoopRunCommandSummary[];
  rounds: LoopRoundSummary[];
  evalResult: LoopEvalResult | null;
  fallbackSuggestedBotImprovements: string[];
}): LoopRunSummary {
  return {
    phase: "command-run",
    projectId: input.project.id,
    projectName: input.project.name,
    status: finalStatus(
      input.commands,
      input.rounds,
      input.evalResult,
      input.project.eval?.minScore,
    ),
    executed: input.commands.length,
    committed: input.rounds.some((round) => round.status === "committed"),
    rounds: input.rounds,
    commands: input.commands,
    evalResult: input.evalResult,
    skills: { approved: input.approvedSkills },
    suggestedBotImprovements:
      input.evalResult?.suggestedBotImprovements ?? input.fallbackSuggestedBotImprovements,
  };
}

function runPreflightCommands(input: {
  project: LoopProjectConfig;
  env: Record<string, string>;
  commands: LoopRunCommandSummary[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): LoopRunCommandSummary[] {
  const failed: LoopRunCommandSummary[] = [];
  for (const command of preflightCommands(input.project)) {
    const invocation: LoopRunCommandInvocation = {
      kind: "preflight",
      command,
      cwd: input.project.path,
      env: { ...input.env },
    };
    const summary = commandSummary(invocation, input.runCommand(invocation));
    input.commands.push(summary);
    if (summary.status !== 0) failed.push(summary);
  }
  return failed;
}

function runPreflight(input: {
  project: LoopProjectConfig;
  env: Record<string, string>;
  commands: LoopRunCommandSummary[];
  rounds: LoopRoundSummary[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentTask?: (invocation: LoopAgentTaskInvocation) => LoopRunCommandResult;
}): boolean {
  let failed = runPreflightCommands(input);
  if (failed.length === 0) return true;
  if (input.project.preflight.repair.agent !== true || input.runAgentTask === undefined) {
    input.rounds.push({
      findingId: "preflight",
      title: "Preflight checks",
      action: "small-refactor",
      status: "failed",
      reason: "preflight failed",
      verificationCommands: preflightCommands(input.project),
    });
    return false;
  }

  const finding = syntheticFinding({
    id: "preflight-repair",
    title: "Repair project preflight",
    prompt: buildPreflightRepairPrompt(input.project, failed),
    verificationCommands: preflightCommands(input.project),
  });
  const result = input.runAgentTask({
    projectId: input.project.id,
    projectName: input.project.name,
    agent: input.project.agent,
    cwd: input.project.path,
    prompt: finding.prompt,
    finding,
  });
  input.commands.push(
    commandSummary(
      { kind: "agent", command: "agent-preflight-repair", cwd: input.project.path, env: {} },
      result,
    ),
  );
  if (result.status !== 0) {
    input.rounds.push({
      findingId: finding.id,
      title: finding.title,
      action: finding.action,
      status: "failed",
      reason: result.stderr || "preflight repair failed",
      verificationCommands: finding.verificationCommands,
    });
    return false;
  }

  failed = runPreflightCommands(input);
  if (failed.length === 0) return true;
  input.rounds.push({
    findingId: finding.id,
    title: finding.title,
    action: finding.action,
    status: "failed",
    reason: "preflight still failed after repair",
    verificationCommands: finding.verificationCommands,
  });
  return false;
}

async function runPreflightAsync(input: {
  project: LoopProjectConfig;
  env: Record<string, string>;
  commands: LoopRunCommandSummary[];
  rounds: LoopRoundSummary[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentTask?: (invocation: LoopAgentTaskInvocation) => Promise<LoopRunCommandResult>;
}): Promise<boolean> {
  let failed = runPreflightCommands(input);
  if (failed.length === 0) return true;
  if (input.project.preflight.repair.agent !== true || input.runAgentTask === undefined) {
    input.rounds.push({
      findingId: "preflight",
      title: "Preflight checks",
      action: "small-refactor",
      status: "failed",
      reason: "preflight failed",
      verificationCommands: preflightCommands(input.project),
    });
    return false;
  }

  const finding = syntheticFinding({
    id: "preflight-repair",
    title: "Repair project preflight",
    prompt: buildPreflightRepairPrompt(input.project, failed),
    verificationCommands: preflightCommands(input.project),
  });
  const result = await input.runAgentTask({
    projectId: input.project.id,
    projectName: input.project.name,
    agent: input.project.agent,
    cwd: input.project.path,
    prompt: finding.prompt,
    finding,
  });
  input.commands.push(
    commandSummary(
      { kind: "agent", command: "agent-preflight-repair", cwd: input.project.path, env: {} },
      result,
    ),
  );
  if (result.status !== 0) {
    input.rounds.push({
      findingId: finding.id,
      title: finding.title,
      action: finding.action,
      status: "failed",
      reason: result.stderr || "preflight repair failed",
      verificationCommands: finding.verificationCommands,
    });
    return false;
  }

  failed = runPreflightCommands(input);
  if (failed.length === 0) return true;
  input.rounds.push({
    findingId: finding.id,
    title: finding.title,
    action: finding.action,
    status: "failed",
    reason: "preflight still failed after repair",
    verificationCommands: finding.verificationCommands,
  });
  return false;
}

function runVerificationCommands(input: {
  project: LoopProjectConfig;
  finding: LoopFinding;
  env: Record<string, string>;
  commands: LoopRunCommandSummary[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): LoopRunCommandSummary | null {
  for (const command of input.finding.verificationCommands) {
    const invocation: LoopRunCommandInvocation = {
      kind: "verification",
      command,
      cwd: input.project.path,
      env: { ...input.env, LOOP_FINDING_ID: input.finding.id },
    };
    const summary = commandSummary(invocation, input.runCommand(invocation));
    input.commands.push(summary);
    if (summary.status !== 0) return summary;
  }
  return null;
}

async function runVerificationCommandsAsync(input: {
  project: LoopProjectConfig;
  finding: LoopFinding;
  env: Record<string, string>;
  commands: LoopRunCommandSummary[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): Promise<LoopRunCommandSummary | null> {
  return runVerificationCommands(input);
}

function runCommit(input: {
  project: LoopProjectConfig;
  finding: LoopFinding;
  commands: LoopRunCommandSummary[];
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): { ok: boolean; commitSha?: string; noChanges?: boolean } {
  const addArgs = ["add", "--", ...input.finding.affectedFiles];
  const addResult = input.runGit({ cwd: input.project.path, args: addArgs });
  input.commands.push(gitCommandSummary(input.project.path, addArgs, addResult));
  if (addResult.status !== 0) return { ok: false };

  const diffArgs = ["diff", "--cached", "--quiet"];
  const diffResult = input.runGit({ cwd: input.project.path, args: diffArgs });
  input.commands.push(gitCommandSummary(input.project.path, diffArgs, diffResult));
  if (diffResult.status === 0) return { ok: true, noChanges: true };
  if (diffResult.status !== 1) return { ok: false };

  const message = `loop(${input.project.id}): ${input.finding.title}`;
  const commitArgs = ["commit", "-m", message];
  const commitResult = input.runGit({ cwd: input.project.path, args: commitArgs });
  input.commands.push(gitCommandSummary(input.project.path, commitArgs, commitResult));
  if (commitResult.status !== 0) return { ok: false };

  const revParseArgs = ["rev-parse", "HEAD"];
  const revParseResult = input.runGit({ cwd: input.project.path, args: revParseArgs });
  input.commands.push(gitCommandSummary(input.project.path, revParseArgs, revParseResult));
  if (revParseResult.status !== 0) return { ok: false };
  const commitSha = revParseResult.stdout.trim();
  return commitSha.length > 0 ? { ok: true, commitSha } : { ok: true };
}

function ensureCommitBranch(input: {
  project: LoopProjectConfig;
  commands: LoopRunCommandSummary[];
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): boolean {
  const branch = input.project.commit.branch;
  if (branch === undefined) return true;

  const switchArgs = ["switch", branch];
  const switchResult = input.runGit({ cwd: input.project.path, args: switchArgs });
  input.commands.push(gitCommandSummary(input.project.path, switchArgs, switchResult));
  if (switchResult.status === 0) return true;

  const createArgs = ["switch", "-c", branch];
  const createResult = input.runGit({ cwd: input.project.path, args: createArgs });
  input.commands.push(gitCommandSummary(input.project.path, createArgs, createResult));
  return createResult.status === 0;
}

function recoverDirtyWorktree(input: {
  project: LoopProjectConfig;
  commands: LoopRunCommandSummary[];
  rounds: LoopRoundSummary[];
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  runAgentTask?: (invocation: LoopAgentTaskInvocation) => LoopRunCommandResult;
}): "clean" | "handled" | "failed" {
  if (input.project.recovery.agent !== true || input.project.recovery.dirtyWorktree !== true) {
    return "clean";
  }
  if (input.runGit === undefined) {
    input.rounds.push({
      findingId: "dirty-worktree-recovery",
      title: "Recover dirty worktree",
      action: "small-refactor",
      status: "failed",
      reason: "dirty worktree recovery requires a git adapter",
      verificationCommands: [],
    });
    return "failed";
  }
  const statusArgs = ["status", "--porcelain"];
  const status = input.runGit({ cwd: input.project.path, args: statusArgs });
  input.commands.push(gitCommandSummary(input.project.path, statusArgs, status));
  if (status.status !== 0) {
    input.rounds.push({
      findingId: "dirty-worktree-recovery",
      title: "Recover dirty worktree",
      action: "small-refactor",
      status: "failed",
      reason: "git status failed",
      verificationCommands: [],
    });
    return "failed";
  }
  if (status.stdout.trim().length === 0) return "clean";
  if (input.runAgentTask === undefined) {
    input.rounds.push({
      findingId: "dirty-worktree-recovery",
      title: "Recover dirty worktree",
      action: "small-refactor",
      status: "failed",
      reason: "dirty worktree recovery requires an active-agent execution adapter",
      verificationCommands: [],
    });
    return "failed";
  }

  const finding = syntheticFinding({
    id: "dirty-worktree-recovery",
    title: "Recover dirty worktree",
    prompt: buildDirtyWorktreeRecoveryPrompt(input.project, status.stdout),
  });
  const result = input.runAgentTask({
    projectId: input.project.id,
    projectName: input.project.name,
    agent: input.project.agent,
    cwd: input.project.path,
    prompt: finding.prompt,
    finding,
  });
  input.commands.push(
    commandSummary(
      { kind: "agent", command: "agent-dirty-worktree-recovery", cwd: input.project.path, env: {} },
      result,
    ),
  );
  if (result.status !== 0) {
    input.rounds.push({
      findingId: finding.id,
      title: finding.title,
      action: finding.action,
      status: "failed",
      reason: result.stderr || "dirty worktree recovery failed",
      verificationCommands: [],
    });
    return "failed";
  }

  const after = input.runGit({ cwd: input.project.path, args: statusArgs });
  input.commands.push(gitCommandSummary(input.project.path, statusArgs, after));
  const clean = after.status === 0 && after.stdout.trim().length === 0;
  input.rounds.push({
    findingId: finding.id,
    title: finding.title,
    action: finding.action,
    status: clean ? "committed" : "failed",
    ...(clean ? {} : { reason: "worktree still dirty after recovery" }),
    verificationCommands: [],
  });
  return clean ? "handled" : "failed";
}

async function recoverDirtyWorktreeAsync(input: {
  project: LoopProjectConfig;
  commands: LoopRunCommandSummary[];
  rounds: LoopRoundSummary[];
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  runAgentTask?: (invocation: LoopAgentTaskInvocation) => Promise<LoopRunCommandResult>;
}): Promise<"clean" | "handled" | "failed"> {
  if (input.project.recovery.agent !== true || input.project.recovery.dirtyWorktree !== true) {
    return "clean";
  }
  if (input.runGit === undefined) {
    input.rounds.push({
      findingId: "dirty-worktree-recovery",
      title: "Recover dirty worktree",
      action: "small-refactor",
      status: "failed",
      reason: "dirty worktree recovery requires a git adapter",
      verificationCommands: [],
    });
    return "failed";
  }
  const statusArgs = ["status", "--porcelain"];
  const status = input.runGit({ cwd: input.project.path, args: statusArgs });
  input.commands.push(gitCommandSummary(input.project.path, statusArgs, status));
  if (status.status !== 0) {
    input.rounds.push({
      findingId: "dirty-worktree-recovery",
      title: "Recover dirty worktree",
      action: "small-refactor",
      status: "failed",
      reason: "git status failed",
      verificationCommands: [],
    });
    return "failed";
  }
  if (status.stdout.trim().length === 0) return "clean";
  if (input.runAgentTask === undefined) {
    input.rounds.push({
      findingId: "dirty-worktree-recovery",
      title: "Recover dirty worktree",
      action: "small-refactor",
      status: "failed",
      reason: "dirty worktree recovery requires an active-agent execution adapter",
      verificationCommands: [],
    });
    return "failed";
  }

  const finding = syntheticFinding({
    id: "dirty-worktree-recovery",
    title: "Recover dirty worktree",
    prompt: buildDirtyWorktreeRecoveryPrompt(input.project, status.stdout),
  });
  const result = await input.runAgentTask({
    projectId: input.project.id,
    projectName: input.project.name,
    agent: input.project.agent,
    cwd: input.project.path,
    prompt: finding.prompt,
    finding,
  });
  input.commands.push(
    commandSummary(
      { kind: "agent", command: "agent-dirty-worktree-recovery", cwd: input.project.path, env: {} },
      result,
    ),
  );
  if (result.status !== 0) {
    input.rounds.push({
      findingId: finding.id,
      title: finding.title,
      action: finding.action,
      status: "failed",
      reason: result.stderr || "dirty worktree recovery failed",
      verificationCommands: [],
    });
    return "failed";
  }

  const after = input.runGit({ cwd: input.project.path, args: statusArgs });
  input.commands.push(gitCommandSummary(input.project.path, statusArgs, after));
  const clean = after.status === 0 && after.stdout.trim().length === 0;
  input.rounds.push({
    findingId: finding.id,
    title: finding.title,
    action: finding.action,
    status: clean ? "committed" : "failed",
    ...(clean ? {} : { reason: "worktree still dirty after recovery" }),
    verificationCommands: [],
  });
  return clean ? "handled" : "failed";
}

function runEval(input: {
  project: LoopProjectConfig;
  env: Record<string, string>;
  commands: LoopRunCommandSummary[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentEval?: (invocation: LoopAgentEvalInvocation) => LoopRunCommandResult;
}): void {
  if (input.project.eval?.command !== undefined) {
    const evalInvocation: LoopRunCommandInvocation = {
      kind: "eval",
      command: input.project.eval.command,
      cwd: input.project.path,
      env: { ...input.env },
    };
    input.commands.push(commandSummary(evalInvocation, input.runCommand(evalInvocation)));
  } else if (input.project.eval?.agent === true) {
    if (input.runAgentEval === undefined) {
      throw new Error(`loop project "${input.project.id}" requires an active-agent eval adapter`);
    }
    const evalInvocation: LoopRunCommandInvocation = {
      kind: "eval",
      command: "agent-eval",
      cwd: input.project.path,
      env: { ...input.env },
    };
    input.commands.push(
      commandSummary(
        evalInvocation,
        input.runAgentEval({
          projectId: input.project.id,
          projectName: input.project.name,
          agent: input.project.agent,
          cwd: input.project.path,
          prompt: buildAgentEvalPrompt(input.project, input.commands),
        }),
      ),
    );
  }
}

function lastEvalCommand(commands: LoopRunCommandSummary[]): LoopRunCommandSummary | undefined {
  for (let index = commands.length - 1; index >= 0; index--) {
    const command = commands[index];
    if (command?.kind === "eval") return command;
  }
  return undefined;
}

async function runEvalAsync(input: {
  project: LoopProjectConfig;
  env: Record<string, string>;
  commands: LoopRunCommandSummary[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentEval?: (invocation: LoopAgentEvalInvocation) => Promise<LoopRunCommandResult>;
}): Promise<void> {
  if (input.project.eval?.command !== undefined) {
    const evalInvocation: LoopRunCommandInvocation = {
      kind: "eval",
      command: input.project.eval.command,
      cwd: input.project.path,
      env: { ...input.env },
    };
    input.commands.push(commandSummary(evalInvocation, input.runCommand(evalInvocation)));
  } else if (input.project.eval?.agent === true) {
    if (input.runAgentEval === undefined) {
      throw new Error(`loop project "${input.project.id}" requires an active-agent eval adapter`);
    }
    const evalInvocation: LoopRunCommandInvocation = {
      kind: "eval",
      command: "agent-eval",
      cwd: input.project.path,
      env: { ...input.env },
    };
    input.commands.push(
      commandSummary(
        evalInvocation,
        await input.runAgentEval({
          projectId: input.project.id,
          projectName: input.project.name,
          agent: input.project.agent,
          cwd: input.project.path,
          prompt: buildAgentEvalPrompt(input.project, input.commands),
        }),
      ),
    );
  }
}

export function runLoopProject(input: {
  config: LoopConfig;
  projectId: string;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentEval?: (invocation: LoopAgentEvalInvocation) => LoopRunCommandResult;
  runAgentTask?: (invocation: LoopAgentTaskInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): LoopRunSummary {
  const project = findProject(input.config, input.projectId);
  const commands: LoopRunCommandSummary[] = [];
  const rounds: LoopRoundSummary[] = [];
  const env = envForProject(project);

  const dirty = recoverDirtyWorktree({
    project,
    commands,
    rounds,
    ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    ...(input.runAgentTask !== undefined ? { runAgentTask: input.runAgentTask } : {}),
  });
  if (dirty !== "clean") {
    return completeSummary({
      project,
      approvedSkills: input.config.skills.approved,
      commands,
      rounds,
      evalResult: null,
      fallbackSuggestedBotImprovements: [],
    });
  }

  if (
    !runPreflight({
      project,
      env,
      commands,
      rounds,
      runCommand: input.runCommand,
      ...(input.runAgentTask !== undefined ? { runAgentTask: input.runAgentTask } : {}),
    })
  ) {
    return completeSummary({
      project,
      approvedSkills: input.config.skills.approved,
      commands,
      rounds,
      evalResult: null,
      fallbackSuggestedBotImprovements: [],
    });
  }

  const assessment: LoopRunCommandInvocation = {
    kind: "assessment",
    command: commandForAssessment(project),
    cwd: project.path,
    env: { ...env },
  };
  const assessmentSummary = commandSummary(assessment, input.runCommand(assessment));
  commands.push(assessmentSummary);
  const assessmentResult = parseAssessmentResult(assessmentSummary.stdout);

  if (assessmentSummary.status === 0) {
    const planned = planFindings(project, assessmentResult.findings);
    rounds.push(...planned.skipped);
    if (project.execution.agent) {
      if (planned.selected.length > 0 && input.runAgentTask === undefined) {
        throw new Error(`loop project "${project.id}" requires an active-agent execution adapter`);
      }
      if (project.commit.enabled && input.runGit === undefined) {
        throw new Error(
          `loop project "${project.id}" requires a git adapter when commit.enabled is true`,
        );
      }
      for (const finding of planned.selected) {
        if (
          project.commit.enabled &&
          input.runGit !== undefined &&
          !ensureCommitBranch({ project, commands, runGit: input.runGit })
        ) {
          rounds.push({
            findingId: finding.id,
            title: finding.title,
            action: finding.action,
            status: "failed",
            reason: "commit branch checkout failed",
            verificationCommands: finding.verificationCommands,
          });
          break;
        }
        const agentInvocation: LoopAgentTaskInvocation = {
          projectId: project.id,
          projectName: project.name,
          agent: project.agent,
          cwd: project.path,
          prompt: buildAgentTaskPrompt(project, finding),
          finding,
        };
        const agentResult = input.runAgentTask?.(agentInvocation) ?? {
          status: 1,
          stdout: "",
          stderr: "missing agent task adapter",
        };
        commands.push(
          commandSummary(
            { kind: "agent", command: "agent-task", cwd: project.path, env: { ...env } },
            agentResult,
          ),
        );
        const round: LoopRoundSummary = {
          findingId: finding.id,
          title: finding.title,
          action: finding.action,
          status: agentResult.status === 0 ? "executed" : "failed",
          verificationCommands: finding.verificationCommands,
          ...(agentResult.status === 0
            ? {}
            : { reason: agentResult.stderr || "agent task failed" }),
        };
        if (agentResult.status !== 0) {
          rounds.push(round);
          break;
        }
        let failedVerification = runVerificationCommands({
          project,
          finding,
          env,
          commands,
          runCommand: input.runCommand,
        });
        for (
          let attempt = 1;
          failedVerification !== null &&
          project.recovery.agent === true &&
          attempt <= project.recovery.maxAttempts &&
          input.runAgentTask !== undefined;
          attempt++
        ) {
          const recoveryFinding = syntheticFinding({
            id: `${finding.id}-verification-recovery-${attempt}`,
            title: `Recover verification for ${finding.title}`,
            prompt: buildVerificationRecoveryPrompt({
              project,
              finding,
              failed: failedVerification,
              attempt,
            }),
            verificationCommands: finding.verificationCommands,
          });
          const recoveryResult = input.runAgentTask({
            projectId: project.id,
            projectName: project.name,
            agent: project.agent,
            cwd: project.path,
            prompt: recoveryFinding.prompt,
            finding: recoveryFinding,
          });
          commands.push(
            commandSummary(
              { kind: "agent", command: "agent-verification-recovery", cwd: project.path, env: {} },
              recoveryResult,
            ),
          );
          if (recoveryResult.status !== 0) break;
          failedVerification = runVerificationCommands({
            project,
            finding,
            env,
            commands,
            runCommand: input.runCommand,
          });
        }
        if (failedVerification !== null) {
          rounds.push({
            ...round,
            status: "failed",
            reason:
              project.recovery.agent === true
                ? "verification failed after recovery"
                : "verification failed",
          });
          break;
        }
        round.status = "verified";
        if (project.commit.enabled && input.runGit !== undefined) {
          const commit = runCommit({ project, finding, commands, runGit: input.runGit });
          if (!commit.ok) {
            rounds.push({ ...round, status: "failed", reason: "commit failed" });
            break;
          }
          if (!commit.noChanges) {
            round.status = "committed";
            if (commit.commitSha !== undefined) round.commitSha = commit.commitSha;
          }
        }
        rounds.push(round);
      }
    } else {
      rounds.push(
        ...planned.selected.map((finding) => skippedRound(finding, "execution.agent is false")),
      );
    }
    if (!rounds.some((round) => round.status === "failed")) {
      runEval({
        project,
        env,
        commands,
        runCommand: input.runCommand,
        ...(input.runAgentEval !== undefined ? { runAgentEval: input.runAgentEval } : {}),
      });
    }
  }

  const evalCommand = lastEvalCommand(commands);
  const evalResult = evalCommand !== undefined ? parseEvalResult(evalCommand.stdout) : null;
  return completeSummary({
    project,
    approvedSkills: input.config.skills.approved,
    commands,
    rounds,
    evalResult,
    fallbackSuggestedBotImprovements: assessmentResult.suggestedBotImprovements,
  });
}

export async function runLoopProjectAsync(input: {
  config: LoopConfig;
  projectId: string;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentEval?: (invocation: LoopAgentEvalInvocation) => Promise<LoopRunCommandResult>;
  runAgentTask?: (invocation: LoopAgentTaskInvocation) => Promise<LoopRunCommandResult>;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): Promise<LoopRunSummary> {
  const project = findProject(input.config, input.projectId);
  const commands: LoopRunCommandSummary[] = [];
  const rounds: LoopRoundSummary[] = [];
  const env = envForProject(project);

  const dirty = await recoverDirtyWorktreeAsync({
    project,
    commands,
    rounds,
    ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    ...(input.runAgentTask !== undefined ? { runAgentTask: input.runAgentTask } : {}),
  });
  if (dirty !== "clean") {
    return completeSummary({
      project,
      approvedSkills: input.config.skills.approved,
      commands,
      rounds,
      evalResult: null,
      fallbackSuggestedBotImprovements: [],
    });
  }

  if (
    !(await runPreflightAsync({
      project,
      env,
      commands,
      rounds,
      runCommand: input.runCommand,
      ...(input.runAgentTask !== undefined ? { runAgentTask: input.runAgentTask } : {}),
    }))
  ) {
    return completeSummary({
      project,
      approvedSkills: input.config.skills.approved,
      commands,
      rounds,
      evalResult: null,
      fallbackSuggestedBotImprovements: [],
    });
  }

  const assessment: LoopRunCommandInvocation = {
    kind: "assessment",
    command: commandForAssessment(project),
    cwd: project.path,
    env: { ...env },
  };
  const assessmentSummary = commandSummary(assessment, input.runCommand(assessment));
  commands.push(assessmentSummary);
  const assessmentResult = parseAssessmentResult(assessmentSummary.stdout);

  if (assessmentSummary.status === 0) {
    const planned = planFindings(project, assessmentResult.findings);
    rounds.push(...planned.skipped);
    if (project.execution.agent) {
      if (planned.selected.length > 0 && input.runAgentTask === undefined) {
        throw new Error(`loop project "${project.id}" requires an active-agent execution adapter`);
      }
      if (project.commit.enabled && input.runGit === undefined) {
        throw new Error(
          `loop project "${project.id}" requires a git adapter when commit.enabled is true`,
        );
      }
      for (const finding of planned.selected) {
        if (
          project.commit.enabled &&
          input.runGit !== undefined &&
          !ensureCommitBranch({ project, commands, runGit: input.runGit })
        ) {
          rounds.push({
            findingId: finding.id,
            title: finding.title,
            action: finding.action,
            status: "failed",
            reason: "commit branch checkout failed",
            verificationCommands: finding.verificationCommands,
          });
          break;
        }
        const agentResult = await input.runAgentTask?.({
          projectId: project.id,
          projectName: project.name,
          agent: project.agent,
          cwd: project.path,
          prompt: buildAgentTaskPrompt(project, finding),
          finding,
        });
        const result = agentResult ?? {
          status: 1,
          stdout: "",
          stderr: "missing agent task adapter",
        };
        commands.push(
          commandSummary(
            { kind: "agent", command: "agent-task", cwd: project.path, env: { ...env } },
            result,
          ),
        );
        const round: LoopRoundSummary = {
          findingId: finding.id,
          title: finding.title,
          action: finding.action,
          status: result.status === 0 ? "executed" : "failed",
          verificationCommands: finding.verificationCommands,
          ...(result.status === 0 ? {} : { reason: result.stderr || "agent task failed" }),
        };
        if (result.status !== 0) {
          rounds.push(round);
          break;
        }
        let failedVerification = await runVerificationCommandsAsync({
          project,
          finding,
          env,
          commands,
          runCommand: input.runCommand,
        });
        for (
          let attempt = 1;
          failedVerification !== null &&
          project.recovery.agent === true &&
          attempt <= project.recovery.maxAttempts &&
          input.runAgentTask !== undefined;
          attempt++
        ) {
          const recoveryFinding = syntheticFinding({
            id: `${finding.id}-verification-recovery-${attempt}`,
            title: `Recover verification for ${finding.title}`,
            prompt: buildVerificationRecoveryPrompt({
              project,
              finding,
              failed: failedVerification,
              attempt,
            }),
            verificationCommands: finding.verificationCommands,
          });
          const recoveryResult = await input.runAgentTask({
            projectId: project.id,
            projectName: project.name,
            agent: project.agent,
            cwd: project.path,
            prompt: recoveryFinding.prompt,
            finding: recoveryFinding,
          });
          commands.push(
            commandSummary(
              { kind: "agent", command: "agent-verification-recovery", cwd: project.path, env: {} },
              recoveryResult,
            ),
          );
          if (recoveryResult.status !== 0) break;
          failedVerification = await runVerificationCommandsAsync({
            project,
            finding,
            env,
            commands,
            runCommand: input.runCommand,
          });
        }
        if (failedVerification !== null) {
          rounds.push({
            ...round,
            status: "failed",
            reason:
              project.recovery.agent === true
                ? "verification failed after recovery"
                : "verification failed",
          });
          break;
        }
        round.status = "verified";
        if (project.commit.enabled && input.runGit !== undefined) {
          const commit = runCommit({ project, finding, commands, runGit: input.runGit });
          if (!commit.ok) {
            rounds.push({ ...round, status: "failed", reason: "commit failed" });
            break;
          }
          if (!commit.noChanges) {
            round.status = "committed";
            if (commit.commitSha !== undefined) round.commitSha = commit.commitSha;
          }
        }
        rounds.push(round);
      }
    } else {
      rounds.push(
        ...planned.selected.map((finding) => skippedRound(finding, "execution.agent is false")),
      );
    }
    if (!rounds.some((round) => round.status === "failed")) {
      await runEvalAsync({
        project,
        env,
        commands,
        runCommand: input.runCommand,
        ...(input.runAgentEval !== undefined ? { runAgentEval: input.runAgentEval } : {}),
      });
    }
  }

  const evalCommand = lastEvalCommand(commands);
  const evalResult = evalCommand !== undefined ? parseEvalResult(evalCommand.stdout) : null;
  return completeSummary({
    project,
    approvedSkills: input.config.skills.approved,
    commands,
    rounds,
    evalResult,
    fallbackSuggestedBotImprovements: assessmentResult.suggestedBotImprovements,
  });
}
