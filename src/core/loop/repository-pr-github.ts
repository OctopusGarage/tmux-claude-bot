import { githubCommandForAccount } from "./github-auth.js";
import {
  isSafePrivateForkWorkflowPolicy,
  type PrivateForkWorkflowPolicy,
  type RepositoryPermission,
  type RepositoryPullRequestObservation,
  type RepositoryPullRequestRecoveryGitHub,
} from "./repository-pr-recovery.js";
import type { LoopRunCommandResult } from "./run.js";

export type RepositoryPullRequestGitHubRun = (command: string) => LoopRunCommandResult;

export type RepositoryPullRequestGitHub = RepositoryPullRequestRecoveryGitHub;

type JsonRecord = Record<string, unknown>;

export function createRepositoryPullRequestGitHub(input: {
  run: RepositoryPullRequestGitHubRun;
}): RepositoryPullRequestGitHub {
  const runJson = (account: string, command: string): unknown => {
    const result = input.run(githubCommandForAccount(account, command));
    if (result.status !== 0) throw new Error(safeGitHubError(result));
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("GitHub returned invalid JSON");
    }
  };

  return {
    observe: ({ repository, number, account }) => {
      assertRepository(repository);
      assertNumber(number, "pull request number");
      const pull = record(runJson(account, `api repos/${repository}/pulls/${number}`));
      const repositoryData = record(runJson(account, `api repos/${repository} --jq '.'`));
      const permission = record(
        runJson(
          account,
          `api repos/${repository}/collaborators/${encodeURIComponent(account)}/permission`,
        ),
      );
      const head = record(pull.head);
      const base = record(pull.base);
      const headRepository = record(head.repo);
      const baseRepository = record(base.repo);
      const headSha = requiredString(head.sha, "pull request head SHA");
      const runs = record(
        runJson(
          account,
          `api repos/${repository}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
        ),
      );
      const privateRepository = repositoryData.private === true;
      const forkPolicy = privateRepository
        ? parseForkPolicy(
            runJson(
              account,
              `api repos/${repository}/actions/permissions/fork-pr-workflows-private-repos`,
            ),
          )
        : undefined;
      const rawState = requiredString(pull.state, "pull request state");
      const state = pull.merged_at !== null && pull.merged_at !== undefined ? "merged" : rawState;
      if (state !== "open" && state !== "closed" && state !== "merged") {
        throw new Error(`unsupported pull request state: ${state}`);
      }
      return {
        repository,
        number,
        state,
        headSha,
        headRepository: requiredString(headRepository.full_name, "head repository"),
        baseRepository: requiredString(baseRepository.full_name, "base repository"),
        isDraft: pull.draft === true,
        mergeable:
          pull.mergeable === true
            ? "mergeable"
            : pull.mergeable === false
              ? "conflicting"
              : "unknown",
        mergeStateStatus:
          typeof pull.mergeable_state === "string" ? pull.mergeable_state.toLowerCase() : "unknown",
        repositoryPrivate: privateRepository,
        actor: account,
        actorPermission: parsePermission(permission.permission),
        workflowRuns: array(runs.workflow_runs)
          .map(parseWorkflowRun)
          .filter((run): run is NonNullable<typeof run> => run !== null && run.headSha === headSha),
        ...(forkPolicy === undefined ? {} : { forkWorkflowPolicy: forkPolicy }),
      };
    },
    execute: (target, action, account) => {
      try {
        assertRepository(target.repository);
        assertNumber(target.number, "pull request number");
        assertSha(target.headSha);
        let command: string;
        if (action.kind === "configure-private-fork-workflows") {
          if (!isSafePrivateForkWorkflowPolicy(action.policy)) {
            return { ok: false, reason: "unsafe private-fork workflow policy refused" };
          }
          command = forkPolicyPutCommand(target.repository, action.policy);
        } else if (action.kind === "mark-ready") {
          command = `pr ready ${target.number} --repo ${target.repository}`;
        } else if (action.kind === "approve-workflow") {
          assertNumber(action.runId, "workflow run id");
          command = `api --method POST repos/${target.repository}/actions/runs/${action.runId}/approve`;
        } else {
          assertNumber(action.runId, "workflow run id");
          command = `run rerun ${action.runId} --repo ${target.repository}`;
        }
        const result = input.run(githubCommandForAccount(account, command));
        if (result.status !== 0) return { ok: false, reason: safeGitHubError(result) };
        if (action.kind === "configure-private-fork-workflows") {
          const verify = parseForkPolicy(
            runJson(
              account,
              `api repos/${target.repository}/actions/permissions/fork-pr-workflows-private-repos`,
            ),
          );
          if (verify === undefined || !isSafePrivateForkWorkflowPolicy(verify)) {
            return { ok: false, reason: "private-fork workflow policy verification failed" };
          }
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: safeMessage(error) };
      }
    },
  };
}

function forkPolicyPutCommand(repository: string, policy: PrivateForkWorkflowPolicy): string {
  return [
    `api --method PUT repos/${repository}/actions/permissions/fork-pr-workflows-private-repos`,
    `-F run_workflows_from_fork_pull_requests=${policy.runWorkflowsFromForkPullRequests}`,
    `-F send_write_tokens_to_workflows=${policy.sendWriteTokensToWorkflows}`,
    `-F send_secrets_and_variables=${policy.sendSecretsAndVariables}`,
    `-F require_approval_for_fork_pr_workflows=${policy.requireApprovalForForkPrWorkflows}`,
  ].join(" ");
}

function parseForkPolicy(value: unknown): PrivateForkWorkflowPolicy | undefined {
  const item = record(value);
  const fields = [
    item.run_workflows_from_fork_pull_requests,
    item.send_write_tokens_to_workflows,
    item.send_secrets_and_variables,
    item.require_approval_for_fork_pr_workflows,
  ];
  if (!fields.every((field) => typeof field === "boolean")) return undefined;
  return {
    runWorkflowsFromForkPullRequests: item.run_workflows_from_fork_pull_requests as boolean,
    sendWriteTokensToWorkflows: item.send_write_tokens_to_workflows as boolean,
    sendSecretsAndVariables: item.send_secrets_and_variables as boolean,
    requireApprovalForForkPrWorkflows: item.require_approval_for_fork_pr_workflows as boolean,
  };
}

function parseWorkflowRun(
  value: unknown,
): RepositoryPullRequestObservation["workflowRuns"][number] | null {
  const item = record(value);
  if (!Number.isSafeInteger(item.id) || typeof item.head_sha !== "string") return null;
  const status = typeof item.status === "string" ? item.status : "unknown";
  return {
    id: item.id as number,
    headSha: item.head_sha,
    status: ["queued", "in_progress", "completed", "waiting", "pending"].includes(status)
      ? (status as RepositoryPullRequestObservation["workflowRuns"][number]["status"])
      : "unknown",
    conclusion: typeof item.conclusion === "string" ? item.conclusion : null,
  };
}

function parsePermission(value: unknown): RepositoryPermission {
  return ["none", "read", "triage", "write", "maintain", "admin"].includes(String(value))
    ? (value as RepositoryPermission)
    : "none";
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`missing ${label}`);
  return value;
}

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("invalid GitHub repository identifier");
  }
}

function assertNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${label}`);
}

function assertSha(value: string): void {
  if (!/^[a-fA-F0-9]{6,64}$/.test(value)) throw new Error("invalid pull request head SHA");
}

function safeGitHubError(result: LoopRunCommandResult): string {
  return safeMessage(result.stderr || result.stdout || "GitHub command failed");
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/https:\/\/[^/@\s]+@/gi, "https://<redacted>@")
    .slice(0, 500);
}
