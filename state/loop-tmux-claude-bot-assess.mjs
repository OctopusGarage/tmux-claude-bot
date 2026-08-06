#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const script = "/Users/kingsonwu/programming/OctopusGarage/tmux-claude-bot/scripts/loop-architecture-assess.mjs";
const result = spawnSync(process.execPath, [
  script,
  "--project-id",
  "tmux-claude-bot",
  "--project-name",
  "tmux-claude-bot",
  "--project-path",
  "/Users/kingsonwu/programming/OctopusGarage/tmux-claude-bot",
  "--target-score",
  process.env.LOOP_PROJECT_TARGET_SCORE ?? "95",
  "--verification-commands",
  ["npm run verify:local", "git diff --check"].join("|"),
  "--affected-files",
  [
    "src",
    "tests",
    "docs",
    "scripts",
    "skills",
    "workflows",
    ".agents",
    ".github",
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md",
    "README.md",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.tests.json",
    "vitest.config.ts",
    "eslint.config.mjs",
    "biome.json",
    "knip.json",
    ".dependency-cruiser.cjs",
  ].join("|"),
  "--required-docs",
  ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "README.md", "llms.txt"].join("|"),
  "--guard-files",
  [
    ".codegraph",
    "package.json",
    "package-lock.json",
    "src",
    "tests",
    "scripts/verify-local.sh",
    ".dependency-cruiser.cjs",
  ].join("|"),
  "--read-instructions",
  "Read AGENTS.md, CLAUDE.md, CONTEXT.md, README.md, llms.txt, and relevant docs before editing. Use CodeGraph before source-code exploration when .codegraph exists.",
  "--preference",
  "Implement at most one small slice. Prefer deeper scheduler/session/agent-control modules, clearer deterministic command contracts, stronger task-audit/loop-supervisor gates, notification reliability, local verification coverage, or change-safety guardrails.",
  "--blocked-semantics",
  "Keep implementation, docs, tests, and local verification aligned when user-visible commands, launchd/systemd behavior, scheduler state, task-audit reporting, loop engineering, PR automation, notification delivery, or agent-control flows change. Do not add direct model-provider API clients, hardcoded personal secrets, broad rewrites, or unmanaged bot-owned AI transports.",
], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
