#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const script = "/Users/kingsonwu/programming/OctopusGarage/tmux-claude-bot/scripts/loop-architecture-assess.mjs";
const result = spawnSync(process.execPath, [
  script,
  "--project-id",
  "alcove",
  "--project-name",
  "alcove",
  "--project-path",
  "/Users/kingsonwu/programming/OctopusGarage/alcove",
  "--target-score",
  process.env.LOOP_PROJECT_TARGET_SCORE ?? "95",
  "--verification-commands",
  ["scripts/smoke.sh", "scripts/check.sh", "git diff --check"].join("|"),
  "--affected-files",
  [
    "src",
    "tests",
    "docs",
    "scripts",
    "site",
    "frontend",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "pyproject.toml",
    "uv.lock",
  ].join("|"),
  "--required-docs",
  ["README.md", "CLAUDE.md", "AGENTS.md", "CONTEXT.md"].join("|"),
  "--guard-files",
  [".codegraph", "pyproject.toml", "uv.lock", "tests", "scripts/check.sh"].join("|"),
  "--read-instructions",
  "Read AGENTS.md, CLAUDE.md, README.md, CONTEXT.md, and relevant docs before editing.",
  "--preference",
  "Implement at most one small slice. Prefer deeper application/domain modules, agent-entry locality, CLI/MCP contract clarity, dashboard/search/testability, or change-safety guards.",
  "--blocked-semantics",
  "Keep implementation and docs aligned when user-visible behavior, storage, CLI/MCP contracts, agent entries, dashboard, radars, connectors, mounts, OKF, smoke, eval, or install flows change. Do not change real user data, secrets, external integration behavior, dashboard build artifacts, or direct model-provider integrations unless the selected slice explicitly requires it and tests prove compatibility.",
], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
