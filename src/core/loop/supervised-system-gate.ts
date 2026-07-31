import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { LoopProjectConfig } from "./config.js";
import type { LoopGitInvocation, LoopRunCommandInvocation, LoopRunCommandResult } from "./run.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import type { completeLoopSupervisorRun } from "./supervisor-completion.js";
import type { LoopWorkOrder } from "./work-order.js";

const log = createLogger("loop.supervised-system-gate");
const DEFAULT_SUPERVISED_PR_CHECK_POLL_ATTEMPTS = 30;
const DEFAULT_SUPERVISED_PR_CHECK_POLL_INTERVAL_SECONDS = 30;

export type SupervisedSystemGateProject = Pick<LoopProjectConfig, "id" | "name" | "path"> & {
  commit: LoopWorkOrder["commitPolicy"];
  pullRequest: NonNullable<LoopWorkOrder["pullRequestPolicy"]>;
};

export type SupervisedSystemGateOutcome = {
  result: LoopSupervisedRunResult;
  failures: string[];
  evidence: string[];
};

export function writeSupervisedSystemGateArtifact(input: {
  workOrder: LoopWorkOrder;
  report: ReturnType<typeof completeLoopSupervisorRun>["report"];
  gate: SupervisedSystemGateOutcome;
  result: LoopSupervisedRunResult;
  writtenAt: number;
}): void {
  const path = join(dirname(input.report.summaryPath), "system-gate.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        workOrderId: input.workOrder.id,
        projectId: input.workOrder.projectId,
        resultStatus: input.result.status,
        accepted: input.gate.failures.length === 0,
        evidence: input.gate.evidence,
        failures: input.gate.failures,
        recoverableFailures: supervisorRevisionFailures(input.gate.failures),
        writtenAt: input.writtenAt,
      },
      null,
      2,
    )}\n`,
  );
}

export function runSupervisedSystemGateOutcome(input: {
  project: SupervisedSystemGateProject;
  workOrder: LoopWorkOrder;
  result: LoopSupervisedRunResult;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): SupervisedSystemGateOutcome {
  if (input.result.status !== "completed") {
    return {
      result: input.result,
      failures: [],
      evidence: [`supervisor result was ${input.result.status}; system acceptance gate skipped`],
    };
  }

  const failures: string[] = [];
  const evidence: string[] = [];
  const discoveryOnlyTask = input.workOrder.task?.kind === "opportunity-discovery";
  const requiresGitGate =
    !discoveryOnlyTask && (input.project.commit.enabled || input.project.pullRequest.enabled);
  if (input.workOrder.workspace !== undefined && input.runGit !== undefined) {
    failures.push(...workspaceRepositoryGate(input.workOrder.workspace, input.runGit));
    if (failures.length === 0) {
      evidence.push(
        `workspace repositories clean and switched back (${input.workOrder.workspace.repositories.length})`,
      );
    }
  }
  if (requiresGitGate && input.runGit === undefined) {
    failures.push("missing git adapter for supervised system gate");
  } else if (requiresGitGate && input.runGit !== undefined) {
    const status = input.runGit({ cwd: input.project.path, args: ["status", "--porcelain"] });
    if (status.status !== 0) {
      failures.push(`git status failed: ${status.stderr || status.stdout || "unknown error"}`);
    } else if (status.stdout.trim().length > 0) {
      failures.push(`worktree is dirty after supervisor completion: ${status.stdout.trim()}`);
    } else {
      evidence.push("target worktree clean");
    }

    if (input.project.pullRequest.enabled) {
      const branch = input.runGit({ cwd: input.project.path, args: ["branch", "--show-current"] });
      if (branch.status !== 0) {
        failures.push(
          `git branch check failed: ${branch.stderr || branch.stdout || "unknown error"}`,
        );
      } else if (branch.stdout.trim() !== input.project.pullRequest.switchBack) {
        failures.push(
          `project branch is "${branch.stdout.trim()}", expected "${input.project.pullRequest.switchBack}"`,
        );
      } else {
        evidence.push(`target branch switched back to ${input.project.pullRequest.switchBack}`);
      }

      if (
        failures.length === 0 &&
        input.workOrder.task?.kind === "repository-pull-request-review" &&
        input.project.pullRequest.autoMerge
      ) {
        failures.push(
          ...syncSwitchBackBranch({
            project: input.project,
            runGit: input.runGit,
          }),
        );
      }
    }
  }

  const supervisorCommitRefs = input.result.summary.commits
    .map((commit) => commit.trim())
    .filter(Boolean);
  const supervisorCommits = supervisorCommitRefs
    .map(normalizeSupervisorCommitId)
    .filter((commit): commit is string => commit !== null);
  const ignoredSupervisorCommitRefs = supervisorCommitRefs.filter(
    (commit) => normalizeSupervisorCommitId(commit) === null,
  );
  if (ignoredSupervisorCommitRefs.length > 0) {
    log.warn("loop engineering ignored non-commit supervisor summary entries", {
      data: {
        projectId: input.project.id,
        projectName: input.project.name,
        ignoredSupervisorCommitRefs,
      },
    });
  }

  const requiresLoopCreatedPullRequestGate =
    input.workOrder.task?.kind !== "pull-request-review" &&
    input.workOrder.task?.kind !== "repository-pull-request-review" &&
    !discoveryOnlyTask;

  if (
    requiresLoopCreatedPullRequestGate &&
    input.project.pullRequest.enabled &&
    supervisorCommitRefs.length > 0
  ) {
    const commitBranch = input.workOrder.commitPolicy.branch;
    if (commitBranch === undefined) {
      failures.push("pullRequest.enabled requires commit.branch for supervised system gate");
    } else if (supervisorCommits.length === 0) {
      failures.push("supervisor summary commits did not include valid commit ids");
    } else {
      const permissionFailures = runGithubAccountPermissionGate({
        project: input.project,
        runCommand: input.runCommand,
      });
      failures.push(...permissionFailures);
      if (permissionFailures.length === 0) {
        const pr = input.runCommand({
          kind: "pr",
          command: [
            ghCommandPrefix(input.project),
            "pr view",
            shellQuoteLocal(commitBranch),
            "--json",
            "url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
          ].join(" "),
          cwd: input.project.path,
          env: {},
        });
        if (pr.status !== 0) {
          failures.push(`PR lookup failed: ${pr.stderr || pr.stdout || "unknown error"}`);
        } else {
          evidence.push("GitHub account permission gate passed");
          let prLookup = pr;
          let prGate = supervisedPullRequestGate({
            stdout: pr.stdout,
            expectedCommits: supervisorCommits,
            projectPath: input.project.path,
            ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
          });
          if (prGate.generatedNoise) {
            const cleanupFailures = cleanGeneratedPullRequestBody({
              project: input.project,
              commitBranch,
              prLookup,
              runCommand: input.runCommand,
            });
            if (cleanupFailures.length > 0) {
              failures.push(...cleanupFailures);
            } else {
              prLookup = input.runCommand({
                kind: "pr",
                command: [
                  ghCommandPrefix(input.project),
                  "pr view",
                  shellQuoteLocal(commitBranch),
                  "--json",
                  "url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
                ].join(" "),
                cwd: input.project.path,
                env: {},
              });
              if (prLookup.status !== 0) {
                failures.push(
                  `PR lookup after body cleanup failed: ${
                    prLookup.stderr || prLookup.stdout || "unknown error"
                  }`,
                );
              } else {
                prGate = supervisedPullRequestGate({
                  stdout: prLookup.stdout,
                  expectedCommits: supervisorCommits,
                  projectPath: input.project.path,
                  ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
                });
              }
            }
          }
          if (
            failures.length === 0 &&
            prGate.failures.length === 0 &&
            prGate.pendingChecks.length > 0
          ) {
            prGate = waitForSupervisedPrChecks({
              project: input.project,
              commitBranch,
              expectedCommits: supervisorCommits,
              runCommand: input.runCommand,
              ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
            });
          }
          failures.push(...prGate.failures, ...pendingCheckFailures(prGate.pendingChecks));
          if (prGate.failures.length === 0 && prGate.pendingChecks.length === 0) {
            evidence.push("PR commit, body, mergeability, and status-check gate passed");
          }
          if (
            failures.length === 0 &&
            input.project.pullRequest.autoMerge &&
            input.runGit !== undefined
          ) {
            const autoMergeFailures = runSupervisedAutoMerge({
              project: input.project,
              commitBranch,
              prState: prGate.state,
              runCommand: input.runCommand,
              runGit: input.runGit,
            });
            failures.push(...autoMergeFailures);
            if (autoMergeFailures.length === 0) {
              evidence.push("auto-merge and switch-back gate passed");
            }
          }
        }
      }
    }
  }

  if (discoveryOnlyTask) evidence.push("discovery-only task; mutating git and PR gates skipped");
  if (!requiresGitGate) evidence.push("no mutating git or PR gate required");
  if (
    requiresLoopCreatedPullRequestGate &&
    input.project.pullRequest.enabled &&
    supervisorCommitRefs.length === 0
  ) {
    evidence.push("PR gate skipped because supervisor reported no commits");
  }

  if (failures.length === 0) return { result: input.result, failures: [], evidence };
  const reason = `supervised system gate failed: ${failures.join("; ")}`;
  log.warn("loop engineering supervised system gate failed", {
    data: { projectId: input.project.id, projectName: input.project.name, failures, evidence },
  });
  return {
    result: {
      status: "supervisor-failed",
      summary: {
        ...input.result.summary,
        status: "failed",
        finalVerification: "failed",
        followUps: [...input.result.summary.followUps, reason],
      },
      output: [input.result.output, reason].filter(Boolean).join("\n"),
    },
    failures,
    evidence,
  };
}

export function supervisorRevisionFailures(failures: string[]): string[] {
  if (failures.length === 0) return [];
  return failures.every(isRecoverableSupervisorGateFailure) ? failures : [];
}

function isRecoverableSupervisorGateFailure(failure: string): boolean {
  if (failure.startsWith("GitHub account ")) return false;
  if (failure.startsWith("missing git adapter")) return false;
  if (failure.startsWith("missing git adapter for supervised PR file hygiene gate")) return false;
  if (failure.startsWith("pullRequest.enabled requires commit.branch")) return false;
  if (failure.startsWith("supervisor summary commits did not include valid commit ids"))
    return true;
  if (failure.startsWith("PR check wait failed")) return false;
  return true;
}

function workspaceRepositoryGate(
  workspace: NonNullable<LoopWorkOrder["workspace"]>,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): string[] {
  const failures: string[] = [];
  for (const repository of workspace.repositories) {
    const status = runGit({ cwd: repository.path, args: ["status", "--porcelain"] });
    if (status.status !== 0) {
      failures.push(
        `${repository.id} git status failed: ${status.stderr || status.stdout || "unknown error"}`,
      );
      continue;
    }
    if (status.stdout.trim().length > 0) {
      failures.push(`${repository.id} worktree is dirty: ${status.stdout.trim()}`);
    }
    const branch = runGit({ cwd: repository.path, args: ["branch", "--show-current"] });
    if (branch.status !== 0) {
      failures.push(
        `${repository.id} git branch check failed: ${
          branch.stderr || branch.stdout || "unknown error"
        }`,
      );
      continue;
    }
    if (branch.stdout.trim() !== repository.pullRequest.switchBack) {
      failures.push(
        `${repository.id} branch is "${branch.stdout.trim()}", expected "${repository.pullRequest.switchBack}"`,
      );
    }
  }
  return failures;
}

export function systemGateProjectFromWorkOrder(
  workOrder: LoopWorkOrder,
): SupervisedSystemGateProject {
  return {
    id: workOrder.projectId,
    name: workOrder.projectName,
    path: workOrder.projectPath,
    commit: workOrder.commitPolicy,
    pullRequest: workOrder.pullRequestPolicy ?? {
      enabled: false,
      base: "main",
      switchBack: "main",
      autoMerge: false,
    },
  };
}

function supervisedPullRequestGate(input: {
  stdout: string;
  expectedCommits: string[];
  projectPath: string;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): { failures: string[]; pendingChecks: string[]; state: string | null; generatedNoise: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch {
    return {
      failures: ["PR lookup did not return JSON"],
      pendingChecks: [],
      state: null,
      generatedNoise: false,
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return {
      failures: ["PR lookup returned invalid JSON"],
      pendingChecks: [],
      state: null,
      generatedNoise: false,
    };
  }
  const pr = parsed as {
    state?: unknown;
    mergeable?: unknown;
    statusCheckRollup?: unknown;
    body?: unknown;
    files?: unknown;
    commits?: unknown;
    mergeCommit?: unknown;
  };
  const failures: string[] = [];
  const pendingChecks: string[] = [];
  const state = typeof pr.state === "string" ? pr.state : null;
  const generatedNoise = typeof pr.body === "string" && containsGeneratedPrNoise(pr.body);
  if (state !== "OPEN" && state !== "MERGED") {
    failures.push(`PR state is ${String(pr.state)}`);
  }
  if (pr.mergeable === "CONFLICTING") {
    failures.push("PR is not mergeable: CONFLICTING");
  }
  if (state !== "MERGED" && Array.isArray(pr.statusCheckRollup)) {
    for (const check of pr.statusCheckRollup) {
      if (check === null || typeof check !== "object") continue;
      const item = check as { status?: unknown; conclusion?: unknown; name?: unknown };
      const status = typeof item.status === "string" ? item.status : "";
      const conclusion = typeof item.conclusion === "string" ? item.conclusion : "";
      const name = typeof item.name === "string" ? item.name : "unnamed check";
      if (status !== "" && status !== "COMPLETED") {
        pendingChecks.push(`CI check "${name}" is ${status}`);
      } else if (conclusion !== "" && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion)) {
        failures.push(`CI check "${name}" concluded ${conclusion}`);
      }
    }
  }
  if (generatedNoise) {
    failures.push("PR body contains generated review noise");
  }

  const mergeCommit = parsePrMergeCommitOid(pr.mergeCommit);
  const expectedCommits = input.expectedCommits
    .map(normalizeSupervisorCommitId)
    .filter((commit): commit is string => commit !== null)
    .filter((commit) => mergeCommit === null || !commitIdsMatch(commit, mergeCommit));
  if (expectedCommits.length > 0) {
    failures.push(...validatePrCommitHygiene(expectedCommits, parsePrCommitOids(pr.commits)));
    if (input.runGit === undefined) {
      failures.push("missing git adapter for supervised PR file hygiene gate");
    } else {
      failures.push(
        ...validatePrFileHygiene({
          expectedCommits,
          prFiles: parsePrFilePaths(pr.files),
          projectPath: input.projectPath,
          runGit: input.runGit,
        }),
      );
    }
  }
  return { failures, pendingChecks, state, generatedNoise };
}

function waitForSupervisedPrChecks(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  expectedCommits: string[];
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): ReturnType<typeof supervisedPullRequestGate> {
  let gate: ReturnType<typeof supervisedPullRequestGate> = {
    failures: [],
    pendingChecks: ["PR checks are pending"],
    state: null,
    generatedNoise: false,
  };
  const attempts = supervisedPrCheckPollAttempts();
  const intervalSeconds = supervisedPrCheckPollIntervalSeconds();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    log.info("loop engineering waiting for PR checks before supervised gate", {
      data: {
        projectId: input.project.id,
        projectName: input.project.name,
        commitBranch: input.commitBranch,
        attempt,
        attempts,
        intervalSeconds,
      },
    });
    const wait = input.runCommand({
      kind: "pr",
      command: `sleep ${intervalSeconds}`,
      cwd: input.project.path,
      env: {},
    });
    if (wait.status !== 0) {
      return {
        ...gate,
        failures: [
          ...gate.failures,
          `PR check wait failed: ${wait.stderr || wait.stdout || "unknown error"}`,
        ],
      };
    }

    const lookup = input.runCommand({
      kind: "pr",
      command: [
        ghCommandPrefix(input.project),
        "pr view",
        shellQuoteLocal(input.commitBranch),
        "--json",
        "url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
      ].join(" "),
      cwd: input.project.path,
      env: {},
    });
    if (lookup.status !== 0) {
      return {
        ...gate,
        failures: [
          ...gate.failures,
          `PR lookup while waiting for checks failed: ${
            lookup.stderr || lookup.stdout || "unknown error"
          }`,
        ],
      };
    }

    gate = supervisedPullRequestGate({
      stdout: lookup.stdout,
      expectedCommits: input.expectedCommits,
      projectPath: input.project.path,
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    });
    if (gate.failures.length > 0 || gate.pendingChecks.length === 0) return gate;
  }

  return gate;
}

function pendingCheckFailures(pendingChecks: string[]): string[] {
  return pendingChecks.map((check) => `${check} after waiting for completion`);
}

function supervisedPrCheckPollAttempts(): number {
  return positiveIntegerEnv(
    "TCB_LOOP_PR_CHECK_POLL_ATTEMPTS",
    DEFAULT_SUPERVISED_PR_CHECK_POLL_ATTEMPTS,
  );
}

function supervisedPrCheckPollIntervalSeconds(): number {
  return positiveIntegerEnv(
    "TCB_LOOP_PR_CHECK_POLL_INTERVAL_SECONDS",
    DEFAULT_SUPERVISED_PR_CHECK_POLL_INTERVAL_SECONDS,
  );
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanGeneratedPullRequestBody(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  prLookup: LoopRunCommandResult;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): string[] {
  const cleaned = cleanedPullRequestBody(input.prLookup.stdout);
  if (cleaned === null) return ["PR body contains generated review noise"];
  const dir = join(appStateDir(), "loop-pr-body-cleanups");
  mkdirSync(dir, { recursive: true });
  const bodyFile = join(dir, `${input.project.id}-${Date.now()}.md`);
  writeFileSync(bodyFile, cleaned, "utf8");
  const edit = input.runCommand({
    kind: "pr",
    command: [
      ghCommandPrefix(input.project),
      "pr edit",
      shellQuoteLocal(input.commitBranch),
      "--body-file",
      shellQuoteLocal(bodyFile),
    ].join(" "),
    cwd: input.project.path,
    env: {},
  });
  if (edit.status !== 0) {
    return [`PR body cleanup failed: ${edit.stderr || edit.stdout || "unknown error"}`];
  }
  log.info("loop engineering cleaned generated PR body noise", {
    data: {
      projectId: input.project.id,
      projectName: input.project.name,
      commitBranch: input.commitBranch,
    },
  });
  return [];
}

function validatePrCommitHygiene(expectedCommits: string[], prCommits: string[]): string[] {
  const failures: string[] = [];
  if (prCommits.length !== expectedCommits.length) {
    failures.push(
      `unexpected PR commit count: expected ${expectedCommits.length}, got ${prCommits.length}`,
    );
  }
  for (const expected of expectedCommits) {
    if (!prCommits.some((actual) => commitIdsMatch(expected, actual))) {
      failures.push(`PR is missing supervisor commit ${expected}`);
    }
  }
  for (const actual of prCommits) {
    if (!expectedCommits.some((expected) => commitIdsMatch(expected, actual))) {
      failures.push(`PR contains commit outside supervisor summary: ${actual}`);
    }
  }
  return failures;
}

function validatePrFileHygiene(input: {
  expectedCommits: string[];
  prFiles: string[];
  projectPath: string;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  if (input.prFiles.length === 0) return [];
  const expectedFiles = new Set<string>();
  const failures: string[] = [];
  for (const commit of input.expectedCommits) {
    const result = input.runGit({
      cwd: input.projectPath,
      args: ["show", "--format=", "--name-only", commit],
    });
    if (result.status !== 0) {
      failures.push(
        `git show ${commit} failed: ${result.stderr || result.stdout || "unknown error"}`,
      );
      continue;
    }
    for (const file of result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      expectedFiles.add(file);
    }
  }
  const unexpectedFiles = input.prFiles.filter((file) => !expectedFiles.has(file));
  if (unexpectedFiles.length > 0) {
    failures.push(
      `PR contains files not produced by supervisor commits: ${unexpectedFiles.join(", ")}`,
    );
  }
  return failures;
}

function parsePrCommitOids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const commits: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const oid = (item as { oid?: unknown }).oid;
    if (typeof oid === "string" && oid.trim().length > 0) commits.push(oid.trim());
  }
  return commits;
}

function parsePrMergeCommitOid(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const oid = (value as { oid?: unknown }).oid;
  return typeof oid === "string" && oid.trim().length > 0 ? oid.trim() : null;
}

function normalizeSupervisorCommitId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^[0-9a-fA-F]{6,40}\b/.exec(trimmed);
  return match?.[0] ?? null;
}

function cleanedPullRequestBody(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const body = (parsed as { body?: unknown }).body;
  if (typeof body !== "string") return null;
  let cleaned = body
    .replace(
      /\n?<!-- This is an auto-generated comment:[\s\S]*?<!-- end of auto-generated comment:[\s\S]*?-->/g,
      "",
    )
    .replace(/\n?## Summary by CodeRabbit[\s\S]*?(?=\n## |\n<!-- |\s*$)/g, "")
    .replace(/\n?<!-- walkthrough_start -->[\s\S]*?(?=\n## |\n<!-- |\s*$)/g, "")
    .replace(/\n?<!-- release_notes_start -->[\s\S]*?(?=\n## |\n<!-- |\s*$)/g, "")
    .trim();
  if (cleaned.length > 0) cleaned += "\n";
  return cleaned !== body ? cleaned : null;
}

function parsePrFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const files: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const path = (item as { path?: unknown }).path;
    if (typeof path === "string" && path.trim().length > 0) files.push(path.trim());
  }
  return files;
}

function commitIdsMatch(expected: string, actual: string): boolean {
  return expected.startsWith(actual) || actual.startsWith(expected);
}

function containsGeneratedPrNoise(body: string): boolean {
  return [
    "<!-- This is an auto-generated comment:",
    "<!-- end of auto-generated comment:",
    "## Summary by CodeRabbit",
    "<!-- walkthrough_start -->",
    "<!-- release_notes_start -->",
  ].some((marker) => body.includes(marker));
}

function runSupervisedAutoMerge(input: {
  project: SupervisedSystemGateProject;
  commitBranch: string;
  prState: string | null;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  const failures: string[] = [];
  if (input.prState === "OPEN") {
    const merge = input.runCommand({
      kind: "pr",
      command: [
        ghCommandPrefix(input.project),
        "pr merge",
        shellQuoteLocal(input.commitBranch),
        "--squash",
        "--delete-branch",
      ].join(" "),
      cwd: input.project.path,
      env: {},
    });
    if (merge.status !== 0) {
      failures.push(`PR auto-merge failed: ${merge.stderr || merge.stdout || "unknown error"}`);
      return failures;
    }
  }

  for (const args of [
    ["switch", input.project.pullRequest.switchBack],
    ["pull", "--ff-only", "origin", input.project.pullRequest.switchBack],
  ]) {
    const result = input.runGit({ cwd: input.project.path, args });
    if (result.status !== 0) {
      failures.push(
        `git ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`,
      );
      return failures;
    }
  }
  return failures;
}

function syncSwitchBackBranch(input: {
  project: SupervisedSystemGateProject;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): string[] {
  const result = input.runGit({
    cwd: input.project.path,
    args: ["pull", "--ff-only", "origin", input.project.pullRequest.switchBack],
  });
  if (result.status === 0) return [];
  return [
    `git pull --ff-only origin ${input.project.pullRequest.switchBack} failed: ${
      result.stderr || result.stdout || "unknown error"
    }`,
  ];
}

function runGithubAccountPermissionGate(input: {
  project: SupervisedSystemGateProject;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): string[] {
  const account = input.project.pullRequest.githubAccount;
  if (account === undefined) return [];
  const result = input.runCommand({
    kind: "pr",
    command: `${ghCommandPrefix(input.project)} repo view --json viewerPermission`,
    cwd: input.project.path,
    env: {},
  });
  if (result.status !== 0) {
    return [
      `GitHub account ${account} permission check failed: ${
        result.stderr || result.stdout || "unknown error"
      }`,
    ];
  }
  const permission = parseViewerPermission(result.stdout);
  if (permission === null) {
    return [`GitHub account ${account} permission check returned invalid JSON`];
  }
  if (!["WRITE", "MAINTAIN", "ADMIN"].includes(permission)) {
    return [
      `GitHub account ${account} has ${permission} permission; WRITE, MAINTAIN, or ADMIN is required`,
    ];
  }
  return [];
}

function parseViewerPermission(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const permission = (parsed as { viewerPermission?: unknown }).viewerPermission;
    return typeof permission === "string" ? permission : null;
  } catch {
    return null;
  }
}

function ghCommandPrefix(project: SupervisedSystemGateProject): string {
  const account = project.pullRequest.githubAccount;
  if (account === undefined) return "gh";
  return `GH_TOKEN="$(gh auth token --user ${shellQuoteLocal(account)})" gh`;
}

function shellQuoteLocal(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runShellCommand(invocation: LoopRunCommandInvocation): LoopRunCommandResult {
  const result = spawnSync("sh", ["-lc", invocation.command], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.error instanceof Error ? result.error.message : result.stderr,
  };
}

export function runGitCommand(invocation: LoopGitInvocation): LoopRunCommandResult {
  const result = spawnSync("git", invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.error instanceof Error ? result.error.message : result.stderr,
  };
}
