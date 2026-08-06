#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const script = "/Users/kingsonwu/programming/OctopusGarage/tmux-claude-bot/scripts/loop-architecture-assess.mjs";
const result = spawnSync(process.execPath, [
  script,
  "--project-id",
  "geo-backend",
  "--project-name",
  "geo-backend",
  "--project-path",
  "/Users/kingsonwu/programming/miao2016/realestate/geo-backend",
  "--target-score",
  process.env.LOOP_PROJECT_TARGET_SCORE ?? "95",
  "--verification-commands",
  [
    ".venv/bin/ruff check src tests",
    ".venv/bin/ruff format --check src tests",
    "uvx semgrep@1.165.0 --config .semgrep --error src",
    ".venv/bin/pyright",
    ".venv/bin/pytest",
    "git diff --check",
  ].join("|"),
  "--affected-files",
  ["src", "tests", "docs", ".semgrep", "pyproject.toml", "uv.lock"].join("|"),
  "--required-docs",
  ["README.md", "CLAUDE.md", "docs/DEVELOP.md", "docs/debug.md"].join("|"),
  "--guard-files",
  [".codegraph", ".semgrep", "pyproject.toml", "uv.lock", "tests"].join("|"),
  "--read-instructions",
  "Read CLAUDE.md and README.md, then obey all project instructions.",
  "--preference",
  "Implement at most one small slice. Prefer deeper route/module interfaces, ownership consolidation, testability, or change-safety guards.",
  "--blocked-semantics",
  "Do not change runtime contracts, authentication semantics, deployment settings, secrets, or direct model-provider integrations unless the selected slice explicitly requires it and tests prove compatibility.",
], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
