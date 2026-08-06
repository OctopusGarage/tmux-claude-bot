#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const projectName = "knowledge-engine";

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const status = run("git", ["status", "--short"]);
if (status.status !== 0) {
  console.log(
    JSON.stringify({
      score: null,
      findings: [],
      suggestedBotImprovements: [
        `${projectName} loop skipped because git status failed: ${status.stderr.trim()}`,
      ],
    }),
  );
  process.exit(0);
}

if (status.stdout.trim().length > 0) {
  console.log(
    JSON.stringify({
      score: null,
      findings: [],
      suggestedBotImprovements: [
        `${projectName} loop skipped because the target worktree is not clean.`,
      ],
    }),
  );
  process.exit(0);
}

const verificationCommands = [
  "uv run ruff check src",
  "uv run ruff format --check src",
  "uv run pyright src",
  'uv run pytest tests/ -m "not integration" --cov=src',
  "git diff --check",
];

const findings = [1, 2, 3].map((round) => ({
  id: `${projectName}-architecture-slice-${round}`,
  title: `Run improve-codebase-architecture for ${projectName} slice ${round}`,
  action: "small-refactor",
  confidence: "high",
  autofixSafety: "guarded",
  affectedFiles: ["src", "tests", "docs", "pyproject.toml", "uv.lock"],
  prompt: [
    "Use the improve-codebase-architecture skill if it is available.",
    `This is scheduled ${projectName} architecture slice ${round} of at most 3 for this run.`,
    "Read CLAUDE.md and README.md, then obey all project instructions.",
    "Start from the current clean worktree and generate the architecture report if the skill calls for it, but do not open it in a browser. Read report files directly from disk.",
    "Before editing, review the candidate: confirm the issue is real, bounded, allowed by project rules, and covered by concrete verification commands. If this review fails, stop and report why.",
    "Auto-select the Top recommendation only when that review shows it is low-risk, bounded, and verifiable.",
    "Implement at most one small slice. Prefer deeper module interfaces, ownership consolidation, testability, or change-safety guards.",
    "Do not change runtime contracts, provider integration semantics, deployment settings, secrets, or direct model-provider integrations unless the selected slice explicitly requires it and tests prove compatibility.",
    "After editing, review git diff, changed files, and verification evidence before handing work back.",
    "Leave changes uncommitted for the loop runner to verify and commit.",
    "Stop immediately on any failed gate.",
    "Report selected issue, pre-edit review conclusion, files changed, verification results, post-edit review conclusion, remaining opportunities, and PR-ready summary.",
  ].join("\n"),
  verificationCommands,
}));

console.log(JSON.stringify({ score: null, findings, suggestedBotImprovements: [] }));
