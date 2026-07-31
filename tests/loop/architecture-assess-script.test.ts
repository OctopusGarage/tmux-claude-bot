import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type AssessmentOutput = {
  score: number | null;
  findings: unknown[];
  suggestedBotImprovements: string[];
};

const script = resolve("scripts/loop-architecture-assess.mjs");

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function assess(cwd: string, extraArgs: string[] = []): AssessmentOutput {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--project-id",
      "sample",
      "--project-name",
      "sample",
      "--project-path",
      cwd,
      "--target-score",
      "95",
      "--verification-commands",
      "git status|git diff --check",
      "--affected-files",
      "src|tests|docs",
      "--required-docs",
      "README.md|CLAUDE.md|docs/DEVELOP.md",
      "--guard-files",
      ".codegraph|.semgrep|pyproject.toml|uv.lock|tests",
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as AssessmentOutput;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-loop-assess-"));
  run("git", ["init"], dir);
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  mkdirSync(join(dir, ".semgrep"), { recursive: true });
  for (const file of ["README.md", "CLAUDE.md", "docs/DEVELOP.md", "pyproject.toml", "uv.lock"]) {
    writeFileSync(join(dir, file), "ok\n");
  }
  writeFileSync(join(dir, "src/app.py"), "print('ok')\n");
  writeFileSync(join(dir, "tests/test_app.py"), "def test_ok():\n    assert True\n");
  run("git", ["add", "."], dir);
  run(
    "git",
    [
      "-c",
      "user.name=Loop Test",
      "-c",
      "user.email=loop-test@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    dir,
  );
  return dir;
}

function writeCompletedRun(stateDir: string, projectId: string): void {
  const runDir = join(stateDir, "loop-runs", projectId, "1785429000000-demo-harness-auto");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "supervisor-final-summary.json"),
    JSON.stringify(
      {
        status: "completed",
        projectId,
        actionsTaken: ["Merged PR #30 into dev."],
        delegatedTasks: [],
        finalVerification: "passed",
        reviewGate: {
          preMutationReview: [],
          postMutationReview: [],
          aiReview: "passed",
          deterministicGates: [
            { name: "round verification", result: "passed" },
            { name: "PR checks", result: "passed" },
            { name: "auto-merge", result: "passed" },
          ],
          decision: "pass",
          notes: [],
        },
        commits: ["abc123 fix: demo", "def456 Merge PR #30"],
        followUps: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(runDir, "system-gate.json"),
    JSON.stringify(
      {
        resultStatus: "completed",
        accepted: true,
        evidence: ["auto-merge and switch-back gate passed"],
      },
      null,
      2,
    ),
  );
}

describe("loop architecture assessment script", () => {
  let dirs: string[] = [];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("returns no findings when the conservative architecture score reaches target", () => {
    const repo = makeRepo();
    dirs.push(repo);

    const result = assess(repo);

    expect(result.score).toBe(95);
    expect(result.findings).toHaveLength(0);
    expect(result.suggestedBotImprovements[0]).toContain("reached target 95");
  });

  it("returns improve-codebase findings when required guard files are missing", () => {
    const repo = makeRepo();
    dirs.push(repo);

    const result = assess(repo, ["--guard-files", ".codegraph|missing-guard"]);

    expect(result.score).toBeLessThan(95);
    expect(result.findings).toHaveLength(3);
  });

  it("does not score or produce findings for a dirty worktree", () => {
    const repo = makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, "dirty.txt"), "dirty\n");

    const result = assess(repo);

    expect(result.score).toBeNull();
    expect(result.findings).toHaveLength(0);
    expect(result.suggestedBotImprovements[0]).toContain("worktree is not clean");
  });

  it("counts completed final summaries and system gates as recent loop evidence", () => {
    const repo = makeRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-assess-state-"));
    dirs.push(repo, stateDir);
    writeCompletedRun(stateDir, "sample");

    const result = assess(repo, [
      "--state-dir",
      stateDir,
      "--guard-files",
      "pyproject.toml|uv.lock|tests|missing.guard",
    ]);

    expect(result.score).toBeGreaterThanOrEqual(95);
    expect(result.findings).toHaveLength(0);
    expect(result.suggestedBotImprovements).toContain(
      "recent completed loop evidence: 1785429000000-demo-harness-auto (system accepted)",
    );
  });
});
