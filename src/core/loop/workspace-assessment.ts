import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";

export type WorkspaceAssessmentRepository = {
  id: string;
  name: string;
  path: string;
};

export type WorkspaceAssessmentResult = {
  score: number | null;
  targetScore: number;
  decision: "skip" | "run" | "block";
  notes: string[];
  blockers: string[];
};

export function parseArchitectureAssessment(
  status: number,
  stdout: string,
  targetScore: number,
): WorkspaceAssessmentResult {
  if (status !== 0) {
    return {
      score: null,
      targetScore,
      decision: "block",
      notes: [],
      blockers: [`assessment command failed with exit status ${status}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return {
      score: null,
      targetScore,
      decision: "block",
      notes: [],
      blockers: ["assessment command did not return valid JSON"],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      score: null,
      targetScore,
      decision: "block",
      notes: [],
      blockers: ["assessment command returned an invalid result"],
    };
  }
  const record = parsed as { score?: unknown; suggestedBotImprovements?: unknown };
  if (typeof record.score !== "number" || !Number.isFinite(record.score)) {
    return {
      score: null,
      targetScore,
      decision: "block",
      notes: [],
      blockers: ["assessment result did not include a numeric score"],
    };
  }
  const score = Math.max(0, Math.min(100, record.score));
  const notes = Array.isArray(record.suggestedBotImprovements)
    ? record.suggestedBotImprovements.filter((item): item is string => typeof item === "string")
    : [];
  return {
    score,
    targetScore,
    decision: score >= targetScore ? "skip" : "run",
    notes,
    blockers: [],
  };
}

type WorkspaceAssessmentInput = {
  targetScore: number;
  repositories: readonly WorkspaceAssessmentRepository[];
  exists: (path: string) => boolean;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
};

const GUIDANCE_FILES = ["README.md", "CLAUDE.md", "AGENTS.md"] as const;
const PROJECT_MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;

export function assessWorkspaceArchitecture(
  input: WorkspaceAssessmentInput,
): WorkspaceAssessmentResult {
  const notes: string[] = [];
  const blockers: string[] = [];
  const scores: number[] = [];

  for (const repository of input.repositories) {
    if (!input.exists(repository.path)) {
      blockers.push(`${repository.id} path does not exist: ${repository.path}`);
      continue;
    }

    const root = input.runGit({ cwd: repository.path, args: ["rev-parse", "--show-toplevel"] });
    if (root.status !== 0) {
      blockers.push(
        `${repository.id} is not a valid git repository: ${root.stderr.trim() || "unknown error"}`,
      );
      continue;
    }
    const expectedRoot = root.stdout.trim();
    if (expectedRoot !== repository.path) {
      blockers.push(
        `${repository.id} git root mismatch: expected ${repository.path}, got ${expectedRoot || "empty"}`,
      );
      continue;
    }

    const status = input.runGit({ cwd: repository.path, args: ["status", "--porcelain"] });
    if (status.status !== 0) {
      blockers.push(
        `${repository.id} git status failed: ${status.stderr.trim() || "unknown error"}`,
      );
      continue;
    }
    if (status.stdout.trim().length > 0) {
      blockers.push(`${repository.id} worktree is dirty: ${status.stdout.trim()}`);
      continue;
    }

    const guidanceCount = GUIDANCE_FILES.filter((file) =>
      input.exists(`${repository.path}/${file}`),
    ).length;
    const manifestPresent = PROJECT_MANIFESTS.some((file) =>
      input.exists(`${repository.path}/${file}`),
    );
    const score = 50 + (guidanceCount >= 2 ? 25 : 0) + (manifestPresent ? 25 : 0);
    scores.push(score);
    notes.push(
      `${repository.id}: clean git root, guidance ${guidanceCount}/${GUIDANCE_FILES.length}, ` +
        `project manifest ${manifestPresent ? "present" : "missing"}, score ${score}`,
    );
  }

  if (blockers.length > 0 || scores.length !== input.repositories.length) {
    return { score: null, targetScore: input.targetScore, decision: "block", notes, blockers };
  }

  const score = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
  return {
    score,
    targetScore: input.targetScore,
    decision: score >= input.targetScore ? "skip" : "run",
    notes,
    blockers,
  };
}
