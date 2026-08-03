import { writeFileSync } from "node:fs";
import { parseLoopConfigYaml } from "../loop/config.js";
import { LOOP_TASK_SCHEDULER_JOB_KINDS } from "../loop/task-family.js";
import {
  buildActiveDelegatedTaskWorkOrder,
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
  buildLoopWorkOrder,
  buildLoopWorkspaceWorkOrder,
  buildRepositoryPullRequestReviewWorkOrder,
} from "../loop/work-order.js";
import {
  actionScopeAtMost,
  governedPromptById,
  governedPromptSpecs,
  governedPromptsForTaskKind,
} from "./registry.js";
import { buildDailyAuditRepairPrompt, buildRuntimeGuardianRepairPrompt } from "./repair-prompts.js";
import type { GovernedPromptId, PromptSpec } from "./types.js";

export type PromptCommandResult =
  | { exitCode: 0; stdout: string; stderr?: never }
  | { exitCode: 1; stdout?: never; stderr: string };

export type PromptGovernanceCheck = {
  ok: boolean;
  promptCount: number;
  missingTaskKinds: string[];
  readOnlyViolations: string[];
  automationGovernanceAutoMergeAllowed: boolean;
};

const READ_ONLY_PROMPT_IDS: readonly GovernedPromptId[] = [
  "loop.policy.opportunity-discovery",
  "opportunity.discussion.single",
  "opportunity.discussion.batch",
  "workflow.audit.finder",
  "workflow.audit.verifier",
];

const PROMPT_EVAL_SOURCE_FILES = [
  "docs/prompt-governance.md",
  "src/core/prompts/registry.ts",
  "src/core/prompts/loop-supervisor.ts",
  "src/core/prompts/repair-prompts.ts",
  "src/core/loop/work-order.ts",
  "src/core/loop/run.ts",
  "src/core/opportunities/view.ts",
  ".claude/workflows/audit.mjs",
  ".agents/skills/arch-loop/SKILL.md",
] as const;

export function runGovernedPromptsCommand(args: string[]): PromptCommandResult {
  const [command, ...rest] = args;
  if (command === "list") return listPrompts(rest);
  if (command === "show") return showPrompt(rest);
  if (command === "render") return renderPrompt(rest);
  if (command === "check") return checkPrompts(rest);
  if (command === "eval") return evalPrompts(rest);
  return {
    exitCode: 1,
    stderr:
      "Usage: prompts governed <list|show|render|check|eval>\n" +
      "Examples:\n" +
      "  prompts governed list [--json]\n" +
      "  prompts governed show <prompt-id> [--json]\n" +
      "  prompts governed render <prompt-id> [--fixture default] [--json]\n" +
      "  prompts governed check [--json]\n" +
      "  prompts governed eval (--all|<prompt-id>) [--output <file>]",
  };
}

export function buildPromptGovernanceCheck(): PromptGovernanceCheck {
  const missingTaskKinds = LOOP_TASK_SCHEDULER_JOB_KINDS.filter(
    (kind) => governedPromptsForTaskKind(kind).length === 0,
  );
  const readOnlyViolations = READ_ONLY_PROMPT_IDS.filter(
    (id) => governedPromptById(id).actionScope !== "read-only",
  );
  const automationGovernanceAutoMergeAllowed = !actionScopeAtMost(
    governedPromptById("loop.policy.automation-governance-review").actionScope,
    "pr-create",
  );
  return {
    ok:
      missingTaskKinds.length === 0 &&
      readOnlyViolations.length === 0 &&
      !automationGovernanceAutoMergeAllowed,
    promptCount: governedPromptSpecs().length,
    missingTaskKinds,
    readOnlyViolations,
    automationGovernanceAutoMergeAllowed,
  };
}

export function buildPromptEvalTask(input: {
  ids: readonly GovernedPromptId[];
  all: boolean;
}): string {
  const prompts = input.ids.map((id) => governedPromptById(id));
  return [
    input.all
      ? "Evaluate all governed system prompts in tmux-claude-bot."
      : `Evaluate governed system prompt ${input.ids.join(", ")} in tmux-claude-bot.`,
    "",
    "Rules:",
    "- Use only the current Claude Code / Codex active-agent surface.",
    "- Do not call model-provider APIs.",
    "- Do not add OpenAI, Anthropic, Gemini, AI SDK, or other model SDKs.",
    "- Do not change source files while evaluating; this is an assessment task.",
    "- Base findings on current repository evidence, not speculation or style preference.",
    "",
    "Sources to inspect:",
    ...PROMPT_EVAL_SOURCE_FILES.map((file) => `- ${file}`),
    "",
    "Prompt ids to evaluate:",
    ...prompts.map(
      (prompt) =>
        `- ${prompt.id}: owner=${prompt.owner}; actionScope=${prompt.actionScope}; risk=${prompt.riskLevel}; eval=${prompt.evalExpectation}`,
    ),
    "",
    "Scoring dimensions:",
    "- Discoverability: prompt id, owner, and source are easy to find.",
    "- Runtime clarity: task, boundary, output contract, and stop condition are clear.",
    "- Policy consistency: allowed and blocked actions align across task families.",
    "- Eval readiness: deterministic tests or active-agent eval expectations exist.",
    "- Change safety: prompt resists mis-edits, stale-code work, over-optimization, and unsafe merge behavior.",
    "- Modularity: prompt text and metadata live at professional, maintainable module boundaries.",
    "- Documentation alignment: docs, registry, tests, and runtime prompt behavior agree.",
    "",
    "Required output:",
    "- Overall score: 0-100.",
    "- Prompt family scores: loop supervisor, loop task policies, repair prompts, legacy loop, opportunity discussion, repo workflows.",
    "- Dimension scores: one 0-100 score for each scoring dimension.",
    "- Findings: P0/P1/P2/P3 only, with file paths, evidence, risk, and repair suggestion.",
    "- Stop decision: stop or continue, with reason. If overall score is at least 90 and no dimension is below 85, recommend stop.",
    "- Do not include nits without a concrete behavioral or governance risk.",
  ].join("\n");
}

function listPrompts(args: string[]): PromptCommandResult {
  const json = parseJsonFlag(args);
  if (json instanceof Error) return { exitCode: 1, stderr: json.message };
  const specs = governedPromptSpecs();
  return {
    exitCode: 0,
    stdout: json
      ? JSON.stringify(specs, null, 2)
      : [
          `governed prompts: ${specs.length}`,
          ...specs.map(
            (prompt) =>
              `- ${prompt.id}: ${prompt.actionScope}, ${prompt.riskLevel}, ${prompt.evalExpectation}`,
          ),
        ].join("\n"),
  };
}

function showPrompt(args: string[]): PromptCommandResult {
  const json = parseJsonFlag(args);
  if (json instanceof Error) return { exitCode: 1, stderr: json.message };
  const id = args.find((arg) => arg !== "--json");
  if (id === undefined) return { exitCode: 1, stderr: "Usage: prompts governed show <prompt-id>" };
  const prompt = findPrompt(id);
  if (prompt instanceof Error) return { exitCode: 1, stderr: prompt.message };
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(prompt, null, 2) : renderPromptSpec(prompt),
  };
}

function renderPrompt(args: string[]): PromptCommandResult {
  const parsed = parseRenderOptions(args);
  if (parsed instanceof Error) return { exitCode: 1, stderr: parsed.message };
  const prompt = findPrompt(parsed.id);
  if (prompt instanceof Error) return { exitCode: 1, stderr: prompt.message };
  const rendered = renderGovernedPrompt(prompt.id, parsed.fixture);
  if (rendered instanceof Error) return { exitCode: 1, stderr: rendered.message };
  if (parsed.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ id: prompt.id, fixture: parsed.fixture, prompt: rendered }, null, 2),
    };
  }
  return { exitCode: 0, stdout: rendered };
}

function checkPrompts(args: string[]): PromptCommandResult {
  const json = parseJsonFlag(args);
  if (json instanceof Error) return { exitCode: 1, stderr: json.message };
  const check = buildPromptGovernanceCheck();
  const stdout = json
    ? JSON.stringify(check, null, 2)
    : [
        check.ok ? "governed prompt check ok" : "governed prompt check failed",
        `prompt count: ${check.promptCount}`,
        `missing task kinds: ${check.missingTaskKinds.length || "none"}`,
        `read-only violations: ${check.readOnlyViolations.length || "none"}`,
        `automation governance auto-merge allowed: ${check.automationGovernanceAutoMergeAllowed}`,
      ].join("\n");
  if (check.ok) return { exitCode: 0, stdout };
  return { exitCode: 1, stderr: stdout };
}

function evalPrompts(args: string[]): PromptCommandResult {
  const parsed = parseEvalOptions(args);
  if (parsed instanceof Error) return { exitCode: 1, stderr: parsed.message };
  const { rest, output } = parsed;
  const all = rest.includes("--all");
  const ids = all ? governedPromptSpecs().map((prompt) => prompt.id) : parsePromptIds(rest);
  if (ids instanceof Error) return { exitCode: 1, stderr: ids.message };
  const prompt = buildPromptEvalTask({ ids, all });
  if (output !== undefined) {
    writeFileSync(output, `${prompt}\n`);
  }
  return { exitCode: 0, stdout: prompt };
}

function renderPromptSpec(prompt: PromptSpec): string {
  return [
    prompt.id,
    `Description: ${prompt.description}`,
    `Owner: ${prompt.owner}`,
    `Audience: ${prompt.audience}`,
    `Risk level: ${prompt.riskLevel}`,
    `Action scope: ${prompt.actionScope}`,
    `Eval expectation: ${prompt.evalExpectation}`,
    `Version: ${prompt.version}`,
    prompt.legacy === true ? "Legacy: true" : "",
    prompt.taskKinds !== undefined ? `Task kinds: ${prompt.taskKinds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonFlag(args: string[]): boolean | Error {
  for (const arg of args) {
    if (arg === "--json") continue;
    if (arg.startsWith("--")) return new Error(`unknown option "${arg}"`);
  }
  return args.includes("--json");
}

function parseRenderOptions(
  args: string[],
): { id: string; fixture: "default"; json: boolean } | Error {
  const rest: string[] = [];
  let fixture: "default" = "default";
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--fixture") {
      const value = args[index + 1];
      if (value === undefined)
        return new Error("prompts governed render --fixture requires a name");
      if (value !== "default") {
        return new Error(`unknown governed prompt render fixture "${value}"`);
      }
      fixture = value;
      index++;
      continue;
    }
    if (arg.startsWith("--")) return new Error(`unknown option "${arg}"`);
    rest.push(arg);
  }
  if (rest.length !== 1) {
    return new Error("Usage: prompts governed render <prompt-id> [--fixture default] [--json]");
  }
  const id = rest[0];
  if (id === undefined) {
    return new Error("Usage: prompts governed render <prompt-id> [--fixture default] [--json]");
  }
  return { id, fixture, json };
}

function parseEvalOptions(args: string[]): { rest: string[]; output?: string } | Error {
  const rest: string[] = [];
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--output") {
      const value = args[index + 1];
      if (value === undefined) return new Error("prompts governed eval --output requires a file");
      output = value;
      index++;
      continue;
    }
    if (arg === "--all") {
      rest.push(arg);
      continue;
    }
    if (arg.startsWith("--")) return new Error(`unknown option "${arg}"`);
    rest.push(arg);
  }
  return output === undefined ? { rest } : { rest, output };
}

function parsePromptIds(args: string[]): GovernedPromptId[] | Error {
  const ids = args.filter((arg) => !arg.startsWith("--"));
  if (ids.length === 0) {
    return new Error("Usage: prompts governed eval (--all|<prompt-id>) [--output <file>]");
  }
  const prompts: GovernedPromptId[] = [];
  for (const id of ids) {
    const prompt = findPrompt(id);
    if (prompt instanceof Error) return prompt;
    prompts.push(prompt.id);
  }
  return prompts;
}

function findPrompt(id: string): PromptSpec | Error {
  const prompt = governedPromptSpecs().find((spec) => spec.id === id);
  return prompt ?? new Error(`unknown governed prompt "${id}"`);
}

function renderGovernedPrompt(id: GovernedPromptId, fixture: "default"): string | Error {
  void fixture;
  if (id === "repair.daily-task-audit") {
    return buildDailyAuditRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      items: [
        {
          taskId: "task-1",
          source: "daily-audit",
          name: "architecture",
          scheduledAt: 1752643800000,
          status: "failed",
          error: "missing supervisor final summary",
          updatedAt: 1752643900000,
        },
      ],
    });
  }
  if (id === "repair.runtime-guardian") {
    return buildRuntimeGuardianRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      mode: "fast-heal",
      findings: [
        {
          kind: "missing-system-gate",
          severity: "high",
          runId: "run-1",
          projectId: "target-project",
          projectPath: "/repo/target-project",
          evidence: ["system-gate.json missing after supervisor completion"],
        },
      ],
    });
  }

  const workOrder = sampleWorkOrderForPrompt(id);
  if (workOrder instanceof Error) return workOrder;
  if (id === "loop.supervisor.finalization") {
    return buildLoopSupervisorFinalizationPrompt(workOrder, "previous output without final marker");
  }
  if (id === "loop.supervisor.revision") {
    return buildLoopSupervisorRevisionPrompt({
      workOrder,
      failures: ["reviewGate.decision is missing"],
      attempt: 1,
      maxAttempts: 2,
      previousOutput: "bad final summary",
    });
  }
  return buildLoopSupervisorPrompt(workOrder);
}

function sampleWorkOrderForPrompt(id: GovernedPromptId) {
  if (!id.startsWith("loop.supervisor.") && !id.startsWith("loop.policy.")) {
    return new Error(`governed prompt "${id}" does not have a built-in render fixture`);
  }
  const config = sampleLoopConfig();
  const project = config.projects[0];
  const repository = config.prReview.repositories[0];
  const workspace = config.workspaces[0];
  if (project === undefined || repository === undefined || workspace === undefined) {
    return new Error("sample governed prompt fixture is invalid");
  }
  if (id === "loop.policy.workspace-architecture") {
    return buildLoopWorkspaceWorkOrder({
      config,
      workspace,
      scheduledAt: 1752643800000,
      runId: "1752643800000-workspace-architecture",
      projectSessionPrefix: "tmux_proj_",
      jobKind: "workspace-architecture",
    });
  }
  if (id === "loop.policy.repository-pull-request-review") {
    return buildRepositoryPullRequestReviewWorkOrder({
      config,
      repository,
      scheduledAt: 1752643800000,
      runId: "1752643800000-repository-pr-review",
    });
  }
  if (id === "loop.policy.repository-pull-request-repair") {
    return buildRepositoryPullRequestReviewWorkOrder({
      config,
      repository: {
        ...repository,
        repair: { ...repository.repair, enabled: true, maxAttempts: 1 },
      },
      scheduledAt: 1752643800000,
      runId: "1752643800000-repository-pr-repair",
    });
  }
  if (id === "loop.policy.active-delegated-task") {
    return buildActiveDelegatedTaskWorkOrder({
      session: "tmux_proj_app",
      projectId: "app",
      projectName: "App",
      projectPath: "/repo/app",
      agent: "codex",
      requirement: "Implement the approved bounded task and preserve unrelated work.",
      scheduledAt: 1752643800000,
      runId: "1752643800000-active-delegated-task",
      projectSessionPrefix: "tmux_proj_",
      projectPolicy: project,
    });
  }
  const jobKind = loopPolicyJobKind(id);
  const runLabel = jobKind ?? "supervisor-main";
  return buildLoopWorkOrder({
    config,
    project,
    scheduledAt: 1752643800000,
    runId: `1752643800000-${runLabel}`,
    projectSessionPrefix: "tmux_proj_",
    ...(jobKind !== undefined ? { jobKind } : {}),
  });
}

function loopPolicyJobKind(id: GovernedPromptId) {
  if (id === "loop.policy.bug-fix") return "bug-fix" as const;
  if (id === "loop.policy.test-coverage") return "test-coverage" as const;
  if (id === "loop.policy.security-maintenance") return "security-maintenance" as const;
  if (id === "loop.policy.harness-auto") return "harness-auto" as const;
  if (id === "loop.policy.opportunity-discovery") return "opportunity-discovery" as const;
  if (id === "loop.policy.automation-governance-review")
    return "automation-governance-review" as const;
  if (id === "loop.policy.pull-request-review") return "pull-request-review" as const;
  return undefined;
}

function sampleLoopConfig() {
  return parseLoopConfigYaml(`
projects:
  - id: app
    name: App
    path: /repo/app
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
    goal: Improve architecture.
    maxRounds: 2
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    commit:
      enabled: true
      branch: loop/app
      perRound: false
    pullRequest:
      enabled: true
      base: dev
      switchBack: dev
      autoMerge: true
      mergeMethod: squash
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, broad-rewrite]
    bugFix:
      enabled: true
      schedule: "0 6 * * *"
      maxRounds: 2
      maxBugsPerRound: 2
      requireRegressionTest: true
    testCoverage:
      enabled: true
      schedule: "0 7 * * *"
      targetCoverage: 80
      maxRounds: 2
      requireMeaningfulTests: true
      allowIntegrationTests: true
      allowSmokeTests: true
      allowE2ETests: false
      allowAiEvalTests: true
    securityMaintenance:
      enabled: true
      schedule: "0 8 * * *"
      maxRounds: 2
      allowDependencyUpdates: true
      allowConfigHardening: true
      allowStaticAnalysisFixes: true
    harnessAuto:
      enabled: true
      schedule: "0 9 * * *"
      maxRounds: 2
      strategy: health-first
      stopWhen:
        healthScoreAtLeast: 90
        noConfirmedIssues: true
      tasks:
        - kind: bug-fix
          enabled: true
          weight: 3
        - kind: test-coverage
          enabled: true
          weight: 2
        - kind: security-maintenance
          enabled: true
          weight: 3
    opportunityDiscovery:
      enabled: true
      schedule: "0 10 * * *"
      maxSuggestions: 3
      minConfidence: medium
      categories: [reliability, testing]
      cooldownDays: 14
      requireEvidence: true
    automationGovernanceReview:
      enabled: true
      schedule: "0 11 * * *"
      targetScore: 90
      maxFindings: 3
      allowRepairPr: true
      requireAiEval: true
    pullRequestReview:
      enabled: true
      schedule: "0 12 * * *"
      lookbackHours: 24
      consecutivePasses: 2
      autoMerge: true
      mergeMethod: squash
prReview:
  repositories:
    - id: app-all-prs
      name: App PRs
      repo: OctopusGarage/app
      path: /repo/app
      agent: codex
      schedule: "0 13 * * *"
      base: dev
      autoMerge: true
      repair:
        enabled: true
        maxAttempts: 1
workspaces:
  - id: workspace
    name: Workspace
    root: /repo/workspace
    agent: codex
    runner:
      kind: agent-supervised
    cleanupPolicy: conservative
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, broad-rewrite]
    architecture:
      enabled: true
      schedule: "0 14 * * *"
      goal: Improve workspace architecture.
      maxRounds: 2
      targetScore: 90
    repositories:
      - id: api
        name: API
        path: /repo/workspace/api
        role: backend
        pullRequest:
          enabled: true
          base: dev
          switchBack: dev
          autoMerge: false
          mergeMethod: squash
      - id: web
        name: Web
        path: /repo/workspace/web
        role: frontend
        pullRequest:
          enabled: true
          base: dev
          switchBack: dev
          autoMerge: false
          mergeMethod: squash
`);
}
