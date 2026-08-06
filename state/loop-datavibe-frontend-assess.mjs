#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const projectName = "datavibe-frontend";

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
  "npm run lint",
  "npm run typecheck",
  "npm run format",
  "npm test",
  "npm run build",
  "git diff --check",
];

const findings = [1, 2, 3].map((round) => ({
  id: `datavibe-frontend-architecture-slice-${round}`,
  title: `Run improve-codebase-architecture for datavibe-frontend slice ${round}`,
  action: "small-refactor",
  confidence: "high",
  autofixSafety: "guarded",
  affectedFiles: [
    "src",
    "e2e",
    "docs",
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "vitest.config.ts",
    "tsconfig.json",
    "tsconfig.test.json",
  ],
  prompt: [
    "Use the improve-codebase-architecture skill if it is available.",
    `This is scheduled datavibe-frontend architecture slice ${round} of at most 3 for this run.`,
    "Read README.md and relevant docs before editing.",
    "Start from the current clean worktree and generate/open the architecture HTML report if the skill calls for it.",
    "Auto-select the Top recommendation only when it is low-risk, bounded, and verifiable.",
    "Implement at most one small slice. Prefer deeper UI/domain modules, state-management locality, testability, or change-safety guards.",
    "Do not change backend contracts, auth behavior, SSE semantics, build deployment behavior, secrets, or direct model-provider integrations unless the selected slice explicitly requires it and tests prove compatibility.",
    "Leave changes uncommitted for the loop runner to verify and commit.",
    "Stop immediately on any failed gate.",
    "Report files changed, verification results, remaining opportunities, and whether the next scheduled slice should continue.",
  ].join("\n"),
  verificationCommands,
}));

console.log(JSON.stringify({ score: null, findings, suggestedBotImprovements: [] }));
