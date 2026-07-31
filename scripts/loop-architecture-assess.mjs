#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) continue;
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function splitList(value) {
  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fileExists(projectPath, relativePath) {
  return existsSync(join(projectPath, relativePath));
}

function executableExists(projectPath, command) {
  const first = command.trim().split(/\s+/)[0];
  if (!first || first.includes("=")) return true;
  if (first.includes("/")) return existsSync(join(projectPath, first));
  const result = run("sh", ["-lc", `command -v ${first}`], projectPath);
  return result.status === 0;
}

function latestCompletedRunScore(projectId, stateDir) {
  const runDir = join(stateDir, "loop-runs", projectId);
  if (!existsSync(runDir)) return { score: 0, notes: ["no previous loop run evidence"] };
  const dirs = readdirSync(runDir)
    .map((name) => join(runDir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  for (const dir of dirs) {
    const summary =
      readJson(join(dir, "supervisor-final-summary.json")) ??
      readJson(join(dir, "supervisor-summary.json"));
    if (!summary) continue;
    if (summary.status !== "completed") continue;
    const systemGate = readJson(join(dir, "system-gate.json"));
    const reviewGate = summary.reviewGate ?? systemGate?.supervisorReviewGate;
    const deterministicGates = Array.isArray(reviewGate?.deterministicGates)
      ? reviewGate.deterministicGates
      : [];
    const passedGateCount = deterministicGates.filter((gate) => {
      if (typeof gate === "string") return /passed|success|clean|merged/i.test(gate);
      return gate?.result === "passed";
    }).length;
    const finalVerificationPassed = summary.finalVerification === "passed";
    const acceptedBySystem = systemGate?.accepted === true || systemGate?.resultStatus === "completed";
    const mergedEvidence =
      systemGate?.resultStatus === "completed" &&
      JSON.stringify([summary.actionsTaken, reviewGate?.deterministicGates, systemGate?.evidence])
        .toLowerCase()
        .includes("merge");
    const commitEvidence = Array.isArray(summary.commits) && summary.commits.length > 0;
    let score = 8;
    if (finalVerificationPassed) score += 3;
    if (acceptedBySystem) score += 3;
    if (passedGateCount >= 3) score += 3;
    if (commitEvidence) score += 2;
    if (mergedEvidence) score += 4;
    return {
      score,
      notes: [
        `recent completed loop evidence: ${basename(dir)}${
          acceptedBySystem ? " (system accepted)" : ""
        }`,
      ],
    };
  }

  return { score: 0, notes: ["no completed supervisor loop evidence"] };
}

function architectureScore(input) {
  const notes = [];
  let score = 0;

  const status = run("git", ["status", "--short"], input.projectPath);
  if (status.status !== 0) {
    return {
      score: null,
      findings: [],
      suggestedBotImprovements: [
        `${input.projectName} loop skipped because git status failed: ${status.stderr.trim()}`,
      ],
    };
  }
  if (status.stdout.trim().length > 0) {
    return {
      score: null,
      findings: [],
      suggestedBotImprovements: [
        `${input.projectName} loop skipped because the target worktree is not clean.`,
      ],
    };
  }
  score += 25;
  notes.push("clean worktree");

  const docsPresent = input.requiredDocs.filter((doc) => fileExists(input.projectPath, doc));
  score += Math.min(15, docsPresent.length * 5);
  notes.push(`project guidance files: ${docsPresent.length}/${input.requiredDocs.length}`);

  const commandsPresent = input.verificationCommands.filter((command) =>
    executableExists(input.projectPath, command),
  );
  score += input.verificationCommands.length > 0
    ? Math.round((commandsPresent.length / input.verificationCommands.length) * 25)
    : 0;
  notes.push(`verification commands available: ${commandsPresent.length}/${input.verificationCommands.length}`);

  const guardFiles = input.guardFiles.filter((file) => fileExists(input.projectPath, file));
  score += input.guardFiles.length > 0
    ? Math.round((guardFiles.length / input.guardFiles.length) * 30)
    : 0;
  notes.push(`architecture guard files: ${guardFiles.length}/${input.guardFiles.length}`);

  const previous = latestCompletedRunScore(input.projectId, input.stateDir);
  score += Math.min(15, previous.score);
  notes.push(...previous.notes);

  return {
    score: Math.max(0, Math.min(100, score)),
    notes,
  };
}

function buildFindings(input) {
  return [1, 2, 3].map((round) => ({
    id: `${input.projectName}-architecture-slice-${round}`,
    title: `Run improve-codebase-architecture for ${input.projectName} slice ${round}`,
    action: "small-refactor",
    confidence: "high",
    autofixSafety: "guarded",
    affectedFiles: input.affectedFiles,
    prompt: [
      "Use the improve-codebase-architecture skill if it is available.",
      `This is scheduled ${input.projectName} architecture slice ${round} of at most 3 for this run.`,
      input.readInstructions,
      "Start from the current clean worktree and generate the architecture report if the skill calls for it, but do not open it in a browser. Read report files directly from disk.",
      "Before editing, review the candidate: confirm the issue is real, bounded, allowed by project rules, and covered by concrete verification commands. If this review fails, stop and report why.",
      "Auto-select the Top recommendation only when that review shows it is low-risk, bounded, and verifiable.",
      input.preference,
      input.blockedSemantics,
      "After editing, review git diff, changed files, and verification evidence before handing work back.",
      "Leave changes uncommitted for the loop runner to verify and commit.",
      "Stop immediately on any failed gate.",
      "Report selected issue, pre-edit review conclusion, files changed, verification results, post-edit review conclusion, remaining opportunities, and PR-ready summary.",
    ].join("\n"),
    verificationCommands: input.verificationCommands,
  }));
}

const args = parseArgs(process.argv.slice(2));
const projectId = args["project-id"];
const projectName = args["project-name"] ?? projectId;
const projectPath = args["project-path"] ?? process.cwd();
const targetScore = Number(args["target-score"] ?? process.env.LOOP_PROJECT_TARGET_SCORE ?? 95);
const stateDir = args["state-dir"] ?? process.env.TCB_STATE_DIR ?? join(process.env.HOME ?? ".", ".tmux-claude-bot", "state");

if (!projectId || !projectName) {
  console.error("missing --project-id or --project-name");
  process.exit(2);
}

const input = {
  projectId,
  projectName,
  projectPath,
  stateDir,
  targetScore,
  verificationCommands: splitList(args["verification-commands"] ?? ""),
  affectedFiles: splitList(args["affected-files"] ?? ""),
  requiredDocs: splitList(args["required-docs"] ?? "README.md|CLAUDE.md|AGENTS.md"),
  guardFiles: splitList(args["guard-files"] ?? ".codegraph|.semgrep|pyproject.toml|package.json|vitest.config.ts"),
  readInstructions:
    args["read-instructions"] ?? "Read CLAUDE.md and README.md, then obey all project instructions.",
  preference:
    args.preference ??
    "Implement at most one small slice. Prefer deeper route/module interfaces, ownership consolidation, testability, or change-safety guards.",
  blockedSemantics:
    args["blocked-semantics"] ??
    "Do not change runtime contracts, authentication semantics, deployment settings, secrets, or direct model-provider integrations unless the selected slice explicitly requires it and tests prove compatibility.",
};

const assessed = architectureScore(input);
if ("findings" in assessed) {
  console.log(JSON.stringify(assessed));
  process.exit(0);
}

if (assessed.score >= targetScore) {
  console.log(
    JSON.stringify({
      score: assessed.score,
      findings: [],
      suggestedBotImprovements: [
        `${projectName} architecture score ${assessed.score} reached target ${targetScore}; skipping optimization to avoid over-optimization.`,
        ...assessed.notes,
      ],
    }),
  );
  process.exit(0);
}

console.log(
  JSON.stringify({
    score: assessed.score,
    findings: buildFindings(input),
    suggestedBotImprovements: assessed.notes,
  }),
);
