#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const script = "/Users/kingsonwu/programming/OctopusGarage/tmux-claude-bot/scripts/loop-architecture-assess.mjs";
const result = spawnSync(process.execPath, [
  script,
  "--project-id",
  "geo-frontend",
  "--project-name",
  "geo-frontend",
  "--project-path",
  "/Users/kingsonwu/programming/miao2016/realestate/geo-frontend",
  "--target-score",
  process.env.LOOP_PROJECT_TARGET_SCORE ?? "95",
  "--verification-commands",
  [
    "npm run lint",
    "npm run typecheck",
    "npm run format",
    "npm test",
    "npm run test:components",
    "npm run build",
    "git diff --check",
  ].join("|"),
  "--affected-files",
  [
    "src",
    "e2e",
    "docs",
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "vitest.config.ts",
    "tsconfig.json",
    "tsconfig.test.json",
  ].join("|"),
  "--required-docs",
  ["README.md", "CLAUDE.md", "AGENTS.md"].join("|"),
  "--guard-files",
  ["package.json", "vite.config.ts", "vitest.config.ts", "tsconfig.json", "tsconfig.test.json"].join("|"),
  "--read-instructions",
  "Read AGENTS.md, CLAUDE.md, README.md, and relevant docs before editing.",
  "--preference",
  "Implement at most one small slice. Prefer deeper UI/domain modules, state-management locality, testability, or change-safety guards.",
  "--blocked-semantics",
  "Do not change backend contracts, auth behavior, API semantics, build deployment behavior, secrets, or direct model-provider integrations unless the selected slice explicitly requires it and tests prove compatibility.",
], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
