import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLoopRemoteBranchMaintenance,
  readLoopRemoteBranchOwnership,
} from "../../src/core/loop/remote-branch-maintenance.js";
import { writeLoopSupervisorWorkerLeaseState } from "../../src/core/loop/supervisor-pool.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

describe("Loop remote branch maintenance composition", () => {
  it("resolves configured project repositories only after exact git-root verification", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-remote-branch-maintenance-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectPath = mkdtempSync(join(tmpdir(), "tcb-remote-branch-maintenance-project-"));
    const configFile = join(projectPath, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: example-project
    name: Example Project
    path: ${projectPath}
    agent: codex
    goal: Maintain the example project.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    commit:
      enabled: true
      branch: loop/example-project/architecture
    pullRequest:
      enabled: true
      base: dev
      switchBack: dev
      githubAccount: example-owner
    allowedActions: [tests]
`,
    );
    const reconcile = vi.fn(async () => ({
      scanned: 0,
      eligible: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    }));
    const maintenance = createLoopRemoteBranchMaintenance({
      configFile,
      runGit: ({ args }) =>
        args.join(" ") === "rev-parse --show-toplevel"
          ? { status: 0, stdout: `${projectPath}\n`, stderr: "" }
          : { status: 1, stdout: "", stderr: "unexpected git command" },
      runCommand: ({ command }) =>
        command.includes("repo view --json nameWithOwner")
          ? {
              status: 0,
              stdout: JSON.stringify({ nameWithOwner: "OctopusGarage/example-project" }),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "unexpected command" },
      reconciler: { reconcile },
    });

    await maintenance.reconcile(1000);

    expect(reconcile).toHaveBeenCalledWith({
      targets: [
        {
          repository: "OctopusGarage/example-project",
          projectId: "example-project",
          account: "example-owner",
          baseBranches: ["dev"],
        },
      ],
      liveBranches: new Set(),
      closedReasons: new Map(),
      now: 1000,
      limitPerRepository: 100,
    });
  });

  it("includes each enabled workspace repository under its repository branch prefix", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-workspace-branch-state-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "tcb-workspace-root-"));
    const backendPath = mkdtempSync(join(tmpdir(), "tcb-workspace-backend-"));
    const frontendPath = mkdtempSync(join(tmpdir(), "tcb-workspace-frontend-"));
    const configFile = join(workspaceRoot, "loop.yml");
    writeFileSync(
      configFile,
      `
workspaces:
  - id: example-workspace
    name: Example Workspace
    root: ${workspaceRoot}
    agent: codex
    repositories:
      - id: example-backend
        name: Example Backend
        path: ${backendPath}
        role: backend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
          githubAccount: example-owner
      - id: example-frontend
        name: Example Frontend
        path: ${frontendPath}
        role: frontend
        pullRequest:
          enabled: true
          base: dev
          switchBack: dev
          githubAccount: example-owner
    architecture:
      enabled: true
      schedule: "0 7 * * *"
      goal: Maintain the workspace.
    bugFix:
      enabled: false
    testCoverage:
      enabled: false
    securityMaintenance:
      enabled: false
    harnessAuto:
      enabled: false
    opportunityDiscovery:
      enabled: false
    pullRequestReview:
      enabled: false
`,
    );
    const reconcile = vi.fn(async () => ({
      scanned: 0,
      eligible: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    }));
    const maintenance = createLoopRemoteBranchMaintenance({
      configFile,
      runGit: ({ cwd }) => ({ status: 0, stdout: `${cwd}\n`, stderr: "" }),
      runCommand: ({ cwd }) => ({
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner:
            cwd === backendPath
              ? "OctopusGarage/example-backend"
              : "OctopusGarage/example-frontend",
        }),
        stderr: "",
      }),
      reconciler: { reconcile },
    });

    await maintenance.reconcile(1000);

    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            repository: "OctopusGarage/example-backend",
            projectId: "example-backend",
            account: "example-owner",
            baseBranches: ["main"],
          },
          {
            repository: "OctopusGarage/example-frontend",
            projectId: "example-frontend",
            account: "example-owner",
            baseBranches: ["dev"],
          },
        ],
      }),
    );
  });

  it("binds unfinished WorkOrders and active leases to their exact durable branch", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-remote-branch-ownership-"));
    const branch = "loop/example-project/architecture/100-worker";
    const workOrder = {
      id: "100-worker",
      scheduledAt: 100,
      projectId: "example-project",
      projectName: "Example Project",
      projectPath: "/repo/example-project",
      agent: "codex",
      goal: "Maintain the project.",
      maxRounds: 1,
      targetScore: 90,
      runner: { kind: "agent-supervised", requireConfirmation: false },
      allowedActions: ["tests"],
      blockedActions: [],
      skills: { approved: [] },
      preflight: { commands: [], repair: { agent: false } },
      assessment: { command: "true" },
      execution: { agent: true },
      recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
      commitPolicy: { enabled: true, perRound: false, branch },
      requiredFinalMarker: "[DONE]",
    } satisfies LoopWorkOrder;
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession: "loop-supervisor-1",
      status: "in-flight",
      now: 100,
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "loop-supervisor-1",
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          projectPath: workOrder.projectPath,
          status: "active",
          leasedAt: 100,
          updatedAt: 100,
        },
      ],
    });

    expect(readLoopRemoteBranchOwnership(101)).toEqual({
      liveBranches: new Set([branch]),
      closedReasons: new Map(),
    });
  });

  it("derives every live workspace repository branch from the durable WorkOrder", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-workspace-branch-ownership-"));
    const workOrder = {
      id: "100-workspace-worker",
      scheduledAt: 100,
      projectId: "example-workspace",
      projectName: "Example Workspace",
      projectPath: "/repo/example-workspace",
      task: { kind: "workspace-architecture" },
      agent: "codex",
      goal: "Maintain the workspace.",
      maxRounds: 1,
      targetScore: 90,
      runner: { kind: "agent-supervised", requireConfirmation: false },
      allowedActions: ["tests"],
      blockedActions: [],
      skills: { approved: [] },
      preflight: { commands: [], repair: { agent: false } },
      assessment: { command: "true" },
      execution: { agent: true },
      recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
      commitPolicy: { enabled: false, perRound: false },
      workspace: {
        root: "/repo/example-workspace",
        repositories: [
          {
            id: "example-backend",
            name: "Example Backend",
            path: "/repo/example-backend",
            role: "backend",
            agent: "codex",
            pullRequest: {
              enabled: true,
              base: "main",
              switchBack: "main",
              autoMerge: true,
              mergeMethod: "squash",
            },
          },
          {
            id: "example-frontend",
            name: "Example Frontend",
            path: "/repo/example-frontend",
            role: "frontend",
            agent: "codex",
            pullRequest: {
              enabled: true,
              base: "dev",
              switchBack: "dev",
              autoMerge: true,
              mergeMethod: "squash",
            },
          },
        ],
      },
      requiredFinalMarker: "[DONE]",
    } satisfies LoopWorkOrder;
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession: "loop-supervisor-1",
      status: "in-flight",
      now: 100,
    });

    expect(readLoopRemoteBranchOwnership(101).liveBranches).toEqual(
      new Set([
        "loop/example-backend/architecture/100-workspace-worker",
        "loop/example-frontend/architecture/100-workspace-worker",
      ]),
    );
  });
});
