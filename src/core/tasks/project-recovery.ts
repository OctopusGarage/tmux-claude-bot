export type RecoveryClassification =
  | "retryable"
  | "waiting-external"
  | "needs-owner-decision"
  | "superseded"
  | "dead-letter";

export type HistoricalRecoveryInput = {
  taskId: string;
  source: string;
  name: string;
  status: string;
  error?: string;
  failureKind?: string;
  summary?: string;
  reportPath?: string;
  artifactText?: string;
  attempt: number;
  laterSuccess?: boolean;
};

export type HistoricalRecoveryClassification = {
  classification: RecoveryClassification;
  reason: string;
};

export type ConfiguredRecoveryTarget = {
  kind: "project" | "repository" | "workspace";
  id: string;
  name: string;
  path: string;
};

export type ConfiguredRecoveryConfig = {
  projects: Array<{ id: string; name: string; path: string }>;
  repositories: Array<{ id: string; name?: string; path: string }>;
  workspaces: Array<{ id: string; name: string; root: string }>;
};

const MAX_RECOVERY_ATTEMPTS = 3;

export function classifyHistoricalFailure(
  input: HistoricalRecoveryInput,
): HistoricalRecoveryClassification {
  if (input.laterSuccess === true) {
    return {
      classification: "superseded",
      reason: "a later successful task supersedes this failure",
    };
  }
  if (input.attempt >= MAX_RECOVERY_ATTEMPTS) {
    return {
      classification: "dead-letter",
      reason: `recovery attempt limit reached (${MAX_RECOVERY_ATTEMPTS})`,
    };
  }

  const evidence = [input.error, input.failureKind, input.summary, input.artifactText]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
  if (/(invalid[- ]summary|missing[- ]final[- ]summary|invalid[- ]output)/.test(evidence)) {
    return {
      classification: "retryable",
      reason: "supervisor completion evidence is invalid or incomplete and can be retried",
    };
  }
  if (/(draft|conflict|conflicting|design decision|fingerprint|token-redaction)/.test(evidence)) {
    return {
      classification: "needs-owner-decision",
      reason: "evidence requires a project-owner or PR decision",
    };
  }
  if (
    /(no .*runner|runner.*(unavailable|assigned|available)|billing|spending limit|payments failed|network timeout|github permission|external service)/.test(
      evidence,
    )
  ) {
    return {
      classification: "waiting-external",
      reason: "evidence points to an external service or execution dependency",
    };
  }
  if (
    /(missing|preflight|dependency|worktree|branch|handoff|dispatch|supervisor-failed|not-found|no pull requests|worker)/.test(
      evidence,
    )
  ) {
    return {
      classification: "retryable",
      reason: evidence.includes("preflight")
        ? "preflight evidence points to a recoverable environment failure"
        : "evidence points to a recoverable environment or orchestration failure",
    };
  }
  return {
    classification: "needs-owner-decision",
    reason: "failure evidence is not specific enough for a safe automatic retry",
  };
}

export function resolveConfiguredRecoveryTarget(
  config: ConfiguredRecoveryConfig,
  input: Pick<HistoricalRecoveryInput, "taskId" | "name">,
  canonicalize: (path: string) => string,
): ConfiguredRecoveryTarget | null {
  const candidates: ConfiguredRecoveryTarget[] = [
    ...config.projects.map((project) => ({
      kind: "project" as const,
      id: project.id,
      name: project.name,
      path: project.path,
    })),
    ...config.repositories.map((repository) => ({
      kind: "repository" as const,
      id: repository.id,
      name: repository.name ?? repository.id,
      path: repository.path,
    })),
    ...config.workspaces.map((workspace) => ({
      kind: "workspace" as const,
      id: workspace.id,
      name: workspace.name,
      path: workspace.root,
    })),
  ];
  const identity = `${input.taskId} ${input.name}`.toLowerCase();
  const matches = candidates
    .filter((candidate) => identity.includes(candidate.id.toLowerCase()))
    .map((candidate) => ({ ...candidate, path: canonicalize(candidate.path) }))
    .sort((a, b) => b.id.length - a.id.length);
  if (matches.length === 0) return null;
  const best = matches[0];
  if (best === undefined) return null;
  if (
    matches.some((candidate) => candidate.id.length === best.id.length && candidate.id !== best.id)
  ) {
    return null;
  }
  return best;
}
