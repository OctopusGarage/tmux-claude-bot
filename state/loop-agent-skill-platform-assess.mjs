import { spawnSync } from "node:child_process";

const projectPath = "/Users/kingsonwu/programming/miao2016/agent-skill-platform";

function gitStatus() {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: projectPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, reason: result.stderr.trim() || "git status failed" };
  }
  return { ok: true, dirty: result.stdout.trim().length > 0 };
}

const status = gitStatus();

if (!status.ok) {
  console.log(
    JSON.stringify({
      score: null,
      findings: [],
      suggestedBotImprovements: [`Loop assessment skipped: ${status.reason}`],
    }),
  );
  process.exit(0);
}

if (status.dirty) {
  console.log(
    JSON.stringify({
      score: null,
      findings: [],
      suggestedBotImprovements: [
        "agent-skill-platform loop skipped because the target worktree is not clean.",
      ],
    }),
  );
  process.exit(0);
}

console.log(
  JSON.stringify({
    score: null,
    findings: [1, 2, 3].map((round) => ({
      id: `daily-improve-codebase-architecture-${round}`,
      title: `Run improve-codebase-architecture slice ${round}`,
      action: "small-refactor",
      confidence: "high",
      autofixSafety: "guarded",
      affectedFiles: ["src", "tests"],
      prompt: [
        "Use the improve-codebase-architecture skill if it is available.",
        `This is scheduled architecture slice ${round} of at most 3 for this run.`,
        "Read CLAUDE.md/AGENTS.md/README and obey project instructions.",
        "Reassess the current code and current uncommitted changes before selecting work.",
        "Generate/open the architecture HTML report if the skill calls for it.",
        "Auto-select the Top recommendation only when it is low-risk, bounded, and verifiable.",
        "Implement at most one small slice. Prefer tests, architecture guards, ownership consolidation, or shallow-interface removal.",
        "Avoid broad rewrites, dependency upgrades, secrets, direct model-provider integrations, and unrelated cleanup.",
        "Leave changes uncommitted. Stop immediately on any failed gate.",
        "Report files changed, verification results, remaining opportunities, and whether the next scheduled slice should continue.",
      ].join("\\n"),
      verificationCommands: [
        "uv run ruff check src tests packages",
        "uv run ruff format --check src packages",
        "uv run pyright",
        'uv run pytest tests/ -q -m "not integration"',
        "git diff --check",
      ],
    })),
    suggestedBotImprovements: [],
  }),
);
