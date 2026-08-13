import { githubCommandForAccount } from "./github-auth.js";
import type {
  LoopRemoteBranchGitHub,
  LoopRemoteBranchObservation,
  LoopRemoteBranchTarget,
} from "./remote-branch-reconciliation.js";
import type { LoopRunCommandResult } from "./run.js";

export type LoopRemoteBranchGitHubRun = (command: string) => LoopRunCommandResult;

type JsonRecord = Record<string, unknown>;

export function createLoopRemoteBranchGitHub(input: {
  run: LoopRemoteBranchGitHubRun;
}): LoopRemoteBranchGitHub {
  const runJson = (target: LoopRemoteBranchTarget, command: string): unknown => {
    const result = input.run(githubCommandForAccount(target.account, command));
    if (result.status !== 0) throw new Error(safeGitHubError(result));
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("GitHub returned invalid JSON");
    }
  };

  return {
    discover: async (target, limit) => {
      assertTarget(target);
      const repository = record(runJson(target, `api repos/${target.repository}`));
      const prefix = `loop/${target.projectId}/`;
      const refs = array(
        runJson(
          target,
          `api 'repos/${target.repository}/git/matching-refs/heads/${encodeURIComponent(prefix)}?per_page=${boundedLimit(limit)}'`,
        ),
      );
      return {
        defaultBranch: requiredString(repository.default_branch, "repository default branch"),
        branches: refs
          .map((value) => requiredString(record(value).ref, "GitHub branch ref"))
          .filter((ref) => ref.startsWith("refs/heads/"))
          .map((ref) => ({ branch: ref.slice("refs/heads/".length) }))
          .filter(({ branch }) => branch.startsWith(prefix))
          .sort((left, right) => left.branch.localeCompare(right.branch))
          .slice(0, boundedLimit(limit)),
      };
    },
    observe: async (target, branch) => {
      assertTarget(target);
      assertBranch(branch);
      const encodedBranch = encodeURIComponent(branch);
      const refResult = input.run(
        githubCommandForAccount(
          target.account,
          `api repos/${target.repository}/git/ref/heads/${encodedBranch}`,
        ),
      );
      if (refResult.status !== 0 && isMissingRef(refResult)) return null;
      if (refResult.status !== 0) throw new Error(safeGitHubError(refResult));
      let ref: JsonRecord;
      try {
        ref = record(JSON.parse(refResult.stdout) as unknown);
      } catch {
        throw new Error("GitHub returned invalid JSON");
      }
      const branchData = record(
        runJson(target, `api repos/${target.repository}/branches/${encodedBranch}`),
      );
      const repository = record(runJson(target, `api repos/${target.repository}`));
      const owner = target.repository.split("/")[0] ?? "";
      const pulls = array(
        runJson(
          target,
          `api 'repos/${target.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100'`,
        ),
      );
      const pullRequests = pulls
        .map((pullRequest) => parsePullRequest(pullRequest, target.repository))
        .filter(
          (pullRequest): pullRequest is NonNullable<typeof pullRequest> => pullRequest !== null,
        );
      for (const pullRequest of pullRequests) {
        if (pullRequest.state !== "closed" || pullRequest.closedAt === undefined) continue;
        const comments = array(
          runJson(
            target,
            `api 'repos/${target.repository}/issues/${pullRequest.number}/comments?per_page=100'`,
          ),
        );
        const closeReason = externalCloseReason(comments, pullRequest.closedAt);
        if (closeReason !== undefined) pullRequest.externalCloseReason = closeReason;
      }
      return {
        repository: target.repository,
        branch,
        sha: requiredString(record(ref.object).sha, "GitHub branch SHA"),
        protected: branchData.protected === true,
        defaultBranch: requiredString(repository.default_branch, "repository default branch"),
        pullRequests,
      } satisfies LoopRemoteBranchObservation;
    },
    delete: async (target, branch, expectedSha) => {
      try {
        assertTarget(target);
        assertBranch(branch);
        assertSha(expectedSha);
        const encodedBranch = encodeURIComponent(branch);
        const observed = input.run(
          githubCommandForAccount(
            target.account,
            `api repos/${target.repository}/git/ref/heads/${encodedBranch}`,
          ),
        );
        if (observed.status !== 0 && isMissingRef(observed)) {
          return { ok: true, alreadyAbsent: true };
        }
        if (observed.status !== 0) {
          return { ok: false, alreadyAbsent: false, reason: safeGitHubError(observed) };
        }
        const observedSha = requiredString(
          record(record(JSON.parse(observed.stdout) as unknown).object).sha,
          "GitHub branch SHA",
        );
        if (observedSha !== expectedSha) {
          return {
            ok: false,
            alreadyAbsent: false,
            reason: "GitHub branch SHA changed before deletion",
          };
        }
        const result = input.run(
          githubCommandForAccount(
            target.account,
            `api --method DELETE repos/${target.repository}/git/refs/heads/${encodedBranch}`,
          ),
        );
        if (result.status === 0) return { ok: true, alreadyAbsent: false };
        if (isMissingRef(result)) return { ok: true, alreadyAbsent: true };
        return { ok: false, alreadyAbsent: false, reason: safeGitHubError(result) };
      } catch (error) {
        return { ok: false, alreadyAbsent: false, reason: safeMessage(error) };
      }
    },
  };
}

function parsePullRequest(
  value: unknown,
  repository: string,
): LoopRemoteBranchObservation["pullRequests"][number] | null {
  const pullRequest = record(value);
  const head = record(pullRequest.head);
  const base = record(pullRequest.base);
  const headRepository = record(head.repo);
  if (requiredString(headRepository.full_name, "pull request head repository") !== repository) {
    return null;
  }
  const rawState = requiredString(pullRequest.state, "pull request state");
  const state =
    pullRequest.merged_at !== null && pullRequest.merged_at !== undefined ? "merged" : rawState;
  if (state !== "open" && state !== "closed" && state !== "merged") {
    throw new Error(`unsupported pull request state: ${state}`);
  }
  if (!Number.isSafeInteger(pullRequest.number) || Number(pullRequest.number) < 1) {
    throw new Error("invalid pull request number");
  }
  return {
    number: pullRequest.number as number,
    state,
    headBranch: requiredString(head.ref, "pull request head branch"),
    headSha: requiredString(head.sha, "pull request head SHA"),
    baseBranch: requiredString(base.ref, "pull request base branch"),
    ...(state === "closed"
      ? { closedAt: requiredString(pullRequest.closed_at, "pull request closed timestamp") }
      : {}),
  };
}

function externalCloseReason(
  comments: unknown[],
  closedAt: string,
): LoopRemoteBranchObservation["pullRequests"][number]["externalCloseReason"] {
  const closedAtMs = Date.parse(closedAt);
  if (!Number.isFinite(closedAtMs)) throw new Error("invalid pull request closed timestamp");
  let reason: LoopRemoteBranchObservation["pullRequests"][number]["externalCloseReason"];
  for (const value of comments) {
    const comment = record(value);
    if (!isRepositoryAuthorized(comment.author_association)) continue;
    const createdAt = Date.parse(requiredString(comment.created_at, "issue comment timestamp"));
    if (!Number.isFinite(createdAt) || createdAt < closedAtMs) continue;
    const parsed = parseCloseReason(requiredString(comment.body, "issue comment body"));
    if (parsed !== undefined) reason = parsed;
  }
  return reason;
}

function isRepositoryAuthorized(value: unknown): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function parseCloseReason(
  body: string,
): LoopRemoteBranchObservation["pullRequests"][number]["externalCloseReason"] {
  const match = /^(duplicate|obsolete|non-actionable|invalid)(?=\s|[-—:])/i.exec(body.trim());
  return match?.[1]?.toLowerCase() as
    | LoopRemoteBranchObservation["pullRequests"][number]["externalCloseReason"]
    | undefined;
}

function assertTarget(target: LoopRemoteBranchTarget): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repository)) {
    throw new Error("invalid GitHub repository identifier");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(target.projectId)) {
    throw new Error("invalid Loop project identifier");
  }
  if (target.account.trim() === "") throw new Error("missing GitHub account");
}

function assertBranch(branch: string): void {
  if (
    branch.trim() === "" ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("//") ||
    /[~^:?*[\\\s]/.test(branch)
  ) {
    throw new Error("invalid GitHub branch name");
  }
}

function assertSha(value: string): void {
  if (!/^[a-fA-F0-9]{6,64}$/.test(value)) throw new Error("invalid GitHub commit SHA");
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid branch discovery limit");
  return Math.min(value, 500);
}

function isMissingRef(result: LoopRunCommandResult): boolean {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /(?:http\s+)?404|reference does not exist|not found/.test(detail);
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
