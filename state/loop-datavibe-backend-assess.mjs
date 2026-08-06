#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const projectName = "datavibe-backend";

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
  ".venv/bin/ruff check src tests",
  ".venv/bin/ruff format --check src tests",
  ".venv/bin/pyright",
  "uvx semgrep@1.165.0 --config .semgrep --error src",
  ".venv/bin/pytest",
  "git diff --check",
];

const findings = [1, 2, 3].map((round) => ({
  id: `datavibe-backend-architecture-slice-${round}`,
  title: `Run improve-codebase-architecture for datavibe-backend slice ${round}`,
  action: "small-refactor",
  confidence: "high",
  autofixSafety: "guarded",
  affectedFiles: ["src", "tests", "docs", ".semgrep", "pyproject.toml", "uv.lock"],
  prompt: [
    "Use the improve-codebase-architecture skill if it is available.",
    `This is scheduled datavibe-backend architecture slice ${round} of at most 3 for this run.`,
    "Read CLAUDE.md and README.md, then obey all project instructions.",
    "Start from the current clean worktree and generate/open the architecture HTML report if the skill calls for it.",
    "Auto-select the Top recommendation only when it is low-risk, bounded, and verifiable.",
    "Implement at most one small slice. Prefer deeper route/module interfaces, ownership consolidation, testability, or change-safety guards.",
    "Do not change runtime contracts, authentication semantics, SSE wire behavior, deployment settings, secrets, or direct model-provider integrations unless the selected slice explicitly requires it and tests prove compatibility.",
    "Leave changes uncommitted for the loop runner to verify and commit.",
    "Stop immediately on any failed gate.",
    "Report files changed, verification results, remaining opportunities, and whether the next scheduled slice should continue.",
  ].join("\n"),
  verificationCommands,
}));

console.log(JSON.stringify({ score: null, findings, suggestedBotImprovements: [] }));
