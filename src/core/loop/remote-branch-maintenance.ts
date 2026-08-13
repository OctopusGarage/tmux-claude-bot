import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parseLoopConfigYaml } from "./config.js";
import { githubCommandForAccount } from "./github-auth.js";
import { createLoopRemoteBranchGitHub } from "./remote-branch-github.js";
import {
  createLoopRemoteBranchReconciler,
  type LoopRemoteBranchCloseReason,
  type LoopRemoteBranchReconciliationSummary,
  type LoopRemoteBranchTarget,
} from "./remote-branch-reconciliation.js";
import { LoopRemoteBranchReconciliationStore } from "./remote-branch-reconciliation-store.js";
import type { LoopGitInvocation, LoopRunCommandInvocation, LoopRunCommandResult } from "./run.js";
import { readLoopSupervisorWorkerLeaseState } from "./supervisor-pool.js";
import { readLoopSupervisorWorkOrderRegistry } from "./supervisor-state.js";
import { type LoopWorkOrder, parseSupervisorFinalSummaryFile } from "./work-order.js";

type Reconciler = {
  reconcile(input: {
    targets: readonly LoopRemoteBranchTarget[];
    liveBranches: ReadonlySet<string>;
    terminalBranches: ReadonlySet<string>;
    closedReasons: ReadonlyMap<string, LoopRemoteBranchCloseReason>;
    now: number;
    limitPerRepository?: number;
  }): Promise<LoopRemoteBranchReconciliationSummary>;
};

export type LoopRemoteBranchMaintenance = {
  reconcile(now: number): Promise<LoopRemoteBranchReconciliationSummary>;
};

export function createLoopRemoteBranchMaintenance(input: {
  configFile: string;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  reconciler?: Reconciler;
}): LoopRemoteBranchMaintenance {
  const reconciler =
    input.reconciler ??
    createLoopRemoteBranchReconciler({
      github: createLoopRemoteBranchGitHub({
        run: (command) =>
          input.runCommand({ kind: "pr", command, cwd: dirname(input.configFile), env: {} }),
      }),
      evidence: new LoopRemoteBranchReconciliationStore(),
    });

  return {
    reconcile: async (now) => {
      const config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
      const targets = configuredTargets(
        [
          ...config.projects.flatMap((project) => {
            const branch = project.commit.branch;
            const account = project.pullRequest.githubAccount;
            return branch !== undefined && account !== undefined
              ? [
                  {
                    id: project.id,
                    path: project.path,
                    enabled:
                      project.enabled && project.commit.enabled && project.pullRequest.enabled,
                    account,
                    base: project.pullRequest.base,
                    switchBack: project.pullRequest.switchBack,
                    branchPrefix: branch,
                  },
                ]
              : [];
          }),
          ...config.workspaces.flatMap((workspace) =>
            workspace.repositories.flatMap((repository) => {
              const account = repository.pullRequest.githubAccount;
              return account === undefined
                ? []
                : [
                    {
                      id: repository.id,
                      path: repository.path,
                      enabled: workspace.enabled && repository.pullRequest.enabled,
                      account,
                      base: repository.pullRequest.base,
                      switchBack: repository.pullRequest.switchBack,
                      branchPrefix: `loop/${repository.id}/`,
                    },
                  ];
            }),
          ),
        ],
        input.runCommand,
        input.runGit,
      );
      const ownership = readLoopRemoteBranchOwnership(now);
      return reconciler.reconcile({
        targets,
        ...ownership,
        now,
        limitPerRepository: 100,
      });
    },
  };
}

export function readLoopRemoteBranchOwnership(now: number): {
  liveBranches: Set<string>;
  terminalBranches: Set<string>;
  closedReasons: Map<string, LoopRemoteBranchCloseReason>;
} {
  const registry = readLoopSupervisorWorkOrderRegistry(now);
  const recordsById = new Map(registry.records.map((record) => [record.workOrder.id, record]));
  const terminalIds = new Set(registry.terminal.map((record) => record.workOrder.id));
  const liveIds = new Set(
    registry.records
      .filter((record) => !terminalIds.has(record.workOrder.id))
      .map((record) => record.workOrder.id),
  );
  for (const lease of readLoopSupervisorWorkerLeaseState().leases) {
    if (lease.status === "active") liveIds.add(lease.workOrderId);
  }
  const liveBranches = new Set<string>();
  for (const workOrderId of liveIds) {
    const workOrder = recordsById.get(workOrderId)?.workOrder;
    if (workOrder === undefined) continue;
    for (const branch of remoteBranchesForWorkOrder(workOrder)) liveBranches.add(branch);
  }

  const terminalBranches = new Set<string>();
  for (const { workOrder } of registry.terminal) {
    for (const branch of remoteBranchesForWorkOrder(workOrder)) terminalBranches.add(branch);
  }

  const closedReasons = new Map<string, LoopRemoteBranchCloseReason>();
  for (const { workOrder } of registry.terminal) {
    const parsed = parseSupervisorFinalSummaryFile(workOrder);
    if (!parsed.ok) continue;
    for (const decision of parsed.summary.pullRequestDecisions ?? []) {
      if (decision.outcome !== "closed" || decision.reason === undefined) continue;
      closedReasons.set(`${decision.repository}#${decision.number}`, decision.reason);
    }
  }
  return { liveBranches, terminalBranches, closedReasons };
}

function remoteBranchesForWorkOrder(workOrder: LoopWorkOrder): string[] {
  const branches: string[] = [];
  if (workOrder.commitPolicy.branch !== undefined) branches.push(workOrder.commitPolicy.branch);
  if (workOrder.workspace === undefined) return branches;
  const taskKind =
    workOrder.task?.kind === "workspace-architecture"
      ? "architecture"
      : (workOrder.task?.kind ?? "architecture");
  for (const repository of workOrder.workspace.repositories) {
    if (repository.pullRequest.enabled) {
      branches.push(`loop/${repository.id}/${taskKind}/${workOrder.id}`);
    }
  }
  return branches;
}

function configuredTargets(
  candidates: Array<{
    id: string;
    path: string;
    enabled: boolean;
    account: string;
    base: string;
    switchBack: string;
    branchPrefix: string;
  }>,
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult,
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult,
): LoopRemoteBranchTarget[] {
  const targets: LoopRemoteBranchTarget[] = [];
  for (const candidate of candidates) {
    if (!candidate.enabled || !candidate.branchPrefix.startsWith(`loop/${candidate.id}/`)) {
      continue;
    }
    const topLevel = runGit({ cwd: candidate.path, args: ["rev-parse", "--show-toplevel"] });
    if (
      topLevel.status !== 0 ||
      topLevel.stdout.trim() === "" ||
      resolvePath(topLevel.stdout.trim()) !== resolvePath(candidate.path)
    ) {
      continue;
    }
    const repository = runCommand({
      kind: "pr",
      command: githubCommandForAccount(candidate.account, "repo view --json nameWithOwner"),
      cwd: candidate.path,
      env: {},
    });
    if (repository.status !== 0) continue;
    const nameWithOwner = parseNameWithOwner(repository.stdout);
    if (nameWithOwner === null) continue;
    targets.push({
      repository: nameWithOwner,
      projectId: candidate.id,
      account: candidate.account,
      baseBranches: [...new Set([candidate.base, candidate.switchBack])],
    });
  }
  return targets;
}

function parseNameWithOwner(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const nameWithOwner = (parsed as { nameWithOwner?: unknown }).nameWithOwner;
    return typeof nameWithOwner === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner)
      ? nameWithOwner
      : null;
  } catch {
    return null;
  }
}
