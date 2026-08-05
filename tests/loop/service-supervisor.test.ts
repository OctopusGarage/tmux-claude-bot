import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopBacklogStore } from "../../src/core/loop/backlog.js";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import type { LoopRunCommandInvocation } from "../../src/core/loop/run.js";
import { LoopSchedulerStore } from "../../src/core/loop/scheduler.js";
import {
  reconcileLoopSupervisorWorkOrders,
  runLoopServiceTickAsync,
  runSupervisedSystemGateOutcome,
  startLoopEngineering,
  writeSupervisedSystemGateArtifact,
} from "../../src/core/loop/service.js";
import {
  readLoopSupervisorWorkerLeaseState,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import {
  buildRepositoryPullRequestReviewWorkOrder,
  type LoopWorkOrder,
} from "../../src/core/loop/work-order.js";
import { NotificationGateway } from "../../src/core/notifications/gateway.js";
import { sessionNameFromPath } from "../../src/core/projects/sessionPathMap.js";
import { DailyTaskLedger, singaporeDayWindow } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function writeLoopConfig(input: {
  runner?: string;
  schedule?: string;
  projectPath: string;
  projectExtra?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-"));
  const file = join(dir, "loop.yml");
  writeFileSync(
    file,
    `
projects:
  - id: hub
    name: Hub
    path: ${input.projectPath}
    agent: codex
    schedule: "${input.schedule ?? "*/5 * * * *"}"
${input.runner ?? ""}
${input.projectExtra ?? ""}
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: [tests]
`,
  );
  return file;
}

function writeRepositoryPrReviewConfig(input: { repoOne: string; repoTwo: string }): string {
  const file = join(input.repoOne, "loop.yml");
  writeFileSync(
    file,
    `
projects:
  - id: placeholder
    name: Placeholder
    path: ${input.repoOne}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
prReview:
  repositories:
    - id: repo-one-prs
      name: Repo One PRs
      path: ${input.repoOne}
      repo: OctopusGarage/repo-one
      agent: codex
      schedule: "*/5 * * * *"
      switchBack: dev
      runner:
        kind: agent-supervised
    - id: repo-two-prs
      name: Repo Two PRs
      path: ${input.repoTwo}
      repo: OctopusGarage/repo-two
      agent: codex
      schedule: "*/5 * * * *"
      switchBack: dev
      runner:
        kind: agent-supervised
`,
  );
  return file;
}

function supervisorSummaryPath(stateDir: string, projectId: string): string {
  const projectReportDir = join(stateDir, "loop-runs", projectId);
  const [runId] = readdirSync(projectReportDir);
  if (runId === undefined) throw new Error(`no supervisor report found for ${projectId}`);
  return join(projectReportDir, runId, "supervisor-summary.json");
}

function finalMarkerFromPrompt(prompt: string): string {
  const marker = prompt.match(/\[LOOP_SUPERVISOR_DONE:[^\]]+\]/)?.[0];
  if (marker === undefined) throw new Error("prompt did not include a final marker");
  return marker;
}

describe("runLoopServiceTickAsync supervised routing", () => {
  it("returns explicit system gate evidence for accepted report-only work", () => {
    const outcome = runSupervisedSystemGateOutcome({
      project: {
        id: "hub",
        name: "Hub",
        path: "/tmp/hub",
        commit: { enabled: false, perRound: false },
        pullRequest: {
          enabled: false,
          base: "main",
          switchBack: "main",
          autoMerge: false,
          mergeMethod: "squash",
        },
      },
      workOrder: {
        id: "run-1",
        projectId: "hub",
        projectName: "Hub",
        projectPath: "/tmp/hub",
        agent: "codex",
        skills: [],
        allowedActions: [],
        blockedActions: [],
        verificationCommands: [],
        commitPolicy: { enabled: false },
      } as never,
      result: {
        status: "completed",
        output: "",
        summary: {
          status: "completed",
          projectId: "hub",
          actionsTaken: [],
          delegatedTasks: [],
          finalVerification: "passed",
          commits: [],
          followUps: [],
        },
      },
      runCommand: () => ({
        kind: "system",
        command: "",
        cwd: "/tmp/hub",
        status: 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.evidence).toContain("no mutating git or PR gate required");
  });

  it("rejects completed supervisor results when the review gate blocks", () => {
    const outcome = runSupervisedSystemGateOutcome({
      project: {
        id: "hub",
        name: "Hub",
        path: "/tmp/hub",
        commit: { enabled: false, perRound: false },
        pullRequest: {
          enabled: false,
          base: "main",
          switchBack: "main",
          autoMerge: false,
          mergeMethod: "squash",
        },
      },
      workOrder: {
        id: "run-1",
        projectId: "hub",
        projectName: "Hub",
        projectPath: "/tmp/hub",
        agent: "codex",
        skills: [],
        allowedActions: [],
        blockedActions: [],
        verificationCommands: [],
        commitPolicy: { enabled: false },
      } as never,
      result: {
        status: "completed",
        output: "",
        summary: {
          status: "completed",
          projectId: "hub",
          actionsTaken: [],
          delegatedTasks: [],
          finalVerification: "passed",
          reviewGate: {
            preMutationReview: ["issue evidence was incomplete"],
            postMutationReview: [],
            aiReview: "failed",
            deterministicGates: [],
            decision: "block",
            notes: ["do not accept without proof"],
          },
          commits: [],
          followUps: [],
        },
      },
      runCommand: () => ({
        kind: "system",
        command: "",
        cwd: "/tmp/hub",
        status: 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(outcome.failures).toContain("supervisor reviewGate decision is block");
    expect(outcome.result.status).toBe("supervisor-failed");
  });

  it("marks system gate artifacts unaccepted when the supervisor result is not completed", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-system-gate-artifact-"));
    const result = {
      status: "dispatch-failed" as const,
      reason: "worker was already leased",
      output: "worker was already leased",
    };
    writeSupervisedSystemGateArtifact({
      workOrder: {
        id: "run-1",
        projectId: "hub",
      } as never,
      report: {
        summaryPath: join(dir, "supervisor-summary.json"),
      } as never,
      gate: {
        result,
        failures: [],
        evidence: ["supervisor result was dispatch-failed; system acceptance gate skipped"],
      },
      result,
      writtenAt: 123,
    });

    expect(JSON.parse(readFileSync(join(dir, "system-gate.json"), "utf8"))).toMatchObject({
      resultStatus: "dispatch-failed",
      accepted: false,
    });
  });

  it("dispatches opportunity discovery work orders and sends new suggestions", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-opportunity-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-opportunity-project-"));
    const configFile = writeLoopConfig({
      projectPath: projectDir,
      schedule: "0 0 * * *",
      runner: ["    runner:", "      kind: agent-supervised"].join("\n"),
      projectExtra: [
        "    opportunityDiscovery:",
        "      enabled: true",
        '      schedule: "15 9 * * *"',
        "      notificationChannel: lark",
        "      maxSuggestions: 1",
        "      minConfidence: medium",
      ].join("\n"),
    });
    const telegramMessages: string[] = [];
    const larkMessages: string[] = [];
    const larkSessions: Array<string | undefined> = [];
    const notifications = new NotificationGateway();
    notifications.register("telegram", async (message) => {
      telegramMessages.push(message);
    });
    notifications.register("lark", async (message, req) => {
      larkMessages.push(message);
      larkSessions.push(req?.session);
    });

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T09:20:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      runSupervisorTask: async (request) => {
        if (request.workOrder.opportunityReportPath === undefined) {
          throw new Error("expected opportunity report path");
        }
        writeFileSync(
          request.workOrder.opportunityReportPath,
          JSON.stringify({
            projectId: request.workOrder.projectId,
            projectName: request.workOrder.projectName,
            generatedAt: "2026-07-16T09:20:00.000Z",
            coverage: "partial",
            checkedSignals: ["README", "scripts"],
            skippedSignals: [],
            suggestions: [
              {
                title: "Add guided setup verification",
                category: "developer-experience",
                confidence: "high",
                problem: "Setup issues require manual command chasing.",
                whyNow: "Doctor and setup commands already exist.",
                value: "Reduces owner time diagnosing installs.",
                evidence: ["doctor command exists", "setup command exists"],
                recommendedApproach: "Add a single setup verification summary.",
                alternatives: ["Only document manual commands"],
                acceptanceCriteria: ["Verification summary reports pass/fail checks"],
                risks: ["May duplicate doctor output"],
                nonGoals: ["Do not change setup behavior"],
                estimatedComplexity: "small",
                delegateRequirement: "Add a setup verification summary using existing checks.",
              },
            ],
          }),
        );
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["discovered one opportunity"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1"],
      notifications,
      projectSessionPrefix: "tmux_proj_",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(telegramMessages).toEqual([]);
    expect(larkSessions).toEqual([sessionNameFromPath(projectDir, "tmux_proj_")]);
    expect(larkMessages.join("\n")).toContain("Opportunity suggestions: Hub");
    expect(larkMessages.join("\n")).toContain("Add guided setup verification");
    expect(larkMessages.join("\n")).toContain("Continue via supervisor");
  });

  it("dispatches supervised test-coverage work orders with the coverage branch", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-test-coverage-"));
    const configFile = writeLoopConfig({
      projectPath: projectDir,
      schedule: "0 0 * * *",
      runner: ["    runner:", "      kind: agent-supervised"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
        "    testCoverage:",
        "      enabled: true",
        '      schedule: "20 14 * * *"',
        "      branch: loop/hub/test-coverage",
        "      targetCoverage: 80",
        "      maxRounds: 5",
      ].join("\n"),
    });
    const dispatched: Array<{ projectId: string; branch: string | undefined; prompt: string }> = [];
    const cleanupCompletedWorkerSession = vi.fn(async () => {});

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T14:25:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("no PR lookup is needed when no commits are reported");
      },
      runGit: (invocation) => {
        const command = invocation.args.join(" ");
        if (command === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (
          command === "fetch origin main" ||
          command === "switch main" ||
          command === "pull --rebase origin main"
        ) {
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        writeLoopSupervisorWorkerLeaseState({
          leases: [
            {
              workerSession: request.session,
              workOrderId: request.workOrder.id,
              projectId: request.workOrder.projectId,
              projectPath: request.workOrder.projectPath,
              status: "active",
              leasedAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        });
        dispatched.push({
          projectId: request.workOrder.projectId,
          branch: request.workOrder.commitPolicy.branch,
          prompt: request.prompt,
        });
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["coverage already above 80 with meaningful tests"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1"],
      resetSupervisorBeforeWorkOrder: "compact",
      projectSessionPrefix: "tmux_proj_",
      cleanupCompletedWorkerSession,
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      projectId: "hub",
      branch: "loop/hub/test-coverage/1784211600000-hub-test-coverage",
    });
    expect(dispatched[0]?.prompt).toContain("Test coverage improvement task.");
    expect(dispatched[0]?.prompt).toContain("Target effective test coverage is at least 80%");
    expect(dispatched[0]?.prompt).toContain(
      "compact --yes before each delegated test-coverage round",
    );
    expect(cleanupCompletedWorkerSession).toHaveBeenCalledWith(
      "tmux_proj_loop-worker-hub-1784211600000-hub-test-coverage",
    );
    expect(readLoopSupervisorWorkerLeaseState()).toEqual({ leases: [] });
  });

  it("dispatches one workspace architecture work order and gates every repository", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-workspace-"));
    const backend = join(root, "geo-backend");
    const frontend = join(root, "geo-frontend");
    mkdirSync(backend, { recursive: true });
    mkdirSync(frontend, { recursive: true });
    mkdirSync(join(backend, ".git"));
    mkdirSync(join(frontend, ".git"));
    const expectedRunId = "1784196600000-geo-workspace";
    const backendWorktree = join(
      process.env.TCB_STATE_DIR,
      "loop-worktrees",
      "geo",
      expectedRunId,
      "geo-backend",
    );
    const frontendWorktree = join(
      process.env.TCB_STATE_DIR,
      "loop-worktrees",
      "geo",
      expectedRunId,
      "geo-frontend",
    );
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: placeholder
    name: Placeholder
    path: ${root}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
workspaces:
  - id: geo
    name: Geo Workspace
    root: ${root}
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: ${backend}
        role: backend
        pullRequest:
          enabled: true
          switchBack: main
      - id: geo-frontend
        name: Geo Frontend
        path: ${frontend}
        role: frontend
        pullRequest:
          enabled: true
          switchBack: main
    architecture:
      enabled: true
      schedule: "*/5 * * * *"
      goal: Improve frontend/backend architecture together.
      maxRounds: 3
      targetScore: 95
      runner:
        kind: agent-supervised
`,
    );
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const dispatchedProjectIds: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("workspace architecture should not run single-repo PR lookup gates");
      },
      runGit: (invocation) => {
        gitCalls.push(invocation);
        const command = invocation.args.join(" ");
        if (invocation.cwd === backend && command === "rev-parse --show-toplevel") {
          return { status: 0, stdout: `${backend}\n`, stderr: "" };
        }
        if (invocation.cwd === frontend && command === "rev-parse --show-toplevel") {
          return { status: 0, stdout: `${frontend}\n`, stderr: "" };
        }
        if (invocation.cwd === backendWorktree && command === "rev-parse --show-toplevel") {
          return { status: 1, stdout: "", stderr: "not a git repository" };
        }
        if (invocation.cwd === frontendWorktree && command === "rev-parse --show-toplevel") {
          return { status: 1, stdout: "", stderr: "not a git repository" };
        }
        if (
          invocation.cwd === backend &&
          command === `worktree add --detach ${backendWorktree} HEAD`
        ) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (
          invocation.cwd === frontend &&
          command === `worktree add --detach ${frontendWorktree} HEAD`
        ) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (
          command === "fetch origin main" ||
          command === "switch main" ||
          command === "pull --rebase origin main"
        ) {
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        dispatchedProjectIds.push(request.workOrder.projectId);
        expect(request.workOrder.workspace?.repositories).toMatchObject([
          { id: "geo-backend", path: backendWorktree, sourcePath: backend },
          { id: "geo-frontend", path: frontendWorktree, sourcePath: frontend },
        ]);
        expect(request.prompt).toContain("Workspace architecture task.");
        expect(request.prompt).toContain("open-worker 'tmux_proj_loop-worker-geo-backend-");
        expect(request.prompt).toContain(`'${backendWorktree}' --agent codex`);
        expect(request.prompt).toContain("open-worker 'tmux_proj_loop-worker-geo-frontend-");
        expect(request.prompt).toContain(`'${frontendWorktree}' --agent codex`);
        expect(request.prompt).toContain(`Original workspace repository geo-backend: ${backend}`);
        expect(request.prompt).toContain(`Original workspace repository geo-frontend: ${frontend}`);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["workspace score reached 95; no changes needed"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1"],
      resetSupervisorBeforeWorkOrder: "compact",
      projectSessionPrefix: "tmux_proj_",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(dispatchedProjectIds).toEqual(["geo"]);
    expect(gitCalls).toContainEqual({
      cwd: backend,
      args: ["worktree", "add", "--detach", backendWorktree, "HEAD"],
    });
    expect(gitCalls).toContainEqual({
      cwd: frontend,
      args: ["worktree", "add", "--detach", frontendWorktree, "HEAD"],
    });
    expect(gitCalls).toContainEqual({ cwd: backendWorktree, args: ["status", "--porcelain"] });
    expect(gitCalls).toContainEqual({ cwd: frontendWorktree, args: ["status", "--porcelain"] });
    expect(gitCalls).toContainEqual({ cwd: backend, args: ["branch", "--show-current"] });
    expect(gitCalls).toContainEqual({ cwd: frontend, args: ["branch", "--show-current"] });
  });

  it("dispatches independent supervised targets across the supervisor pool with a clear reset", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const repoOne = mkdtempSync(join(tmpdir(), "tcb-loop-pool-one-"));
    const repoTwo = mkdtempSync(join(tmpdir(), "tcb-loop-pool-two-"));
    const configFile = join(repoOne, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: placeholder
    name: Placeholder
    path: ${repoOne}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
prReview:
  repositories:
    - id: repo-one-prs
      name: Repo One PRs
      path: ${repoOne}
      repo: OctopusGarage/repo-one
      agent: codex
      schedule: "*/5 * * * *"
      switchBack: dev
      runner:
        kind: agent-supervised
    - id: repo-two-prs
      name: Repo Two PRs
      path: ${repoTwo}
      repo: OctopusGarage/repo-two
      agent: codex
      schedule: "*/5 * * * *"
      switchBack: dev
      runner:
        kind: agent-supervised
`,
    );
    const sessions: string[] = [];
    const resets: Array<string | undefined> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("repository PR review should not call gh gates");
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        sessions.push(request.session);
        resets.push(request.contextReset);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["reviewed all open pull requests"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: ["No merge needed"],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"],
      resetSupervisorBeforeWorkOrder: "clear",
    });

    expect(result).toMatchObject({ ran: 2, failed: 0 });
    expect(sessions).toEqual(["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"]);
    expect(resets).toEqual(["clear", "clear"]);
    expect(maxInFlight).toBe(2);
  });

  it("lets harness-auto consume covered same-project subtasks in the same tick", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-harness-conflict-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-harness-conflict-project-"));
    const configFile = join(projectDir, "loop.yml");
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    goal: Improve project health.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    runner:
      kind: agent-supervised
    execution:
      agent: true
    allowedActions: [tests]
    bugFix:
      enabled: true
      schedule: "10 10 * * *"
    harnessAuto:
      enabled: true
      schedule: "10 10 * * *"
      tasks:
        - kind: bug-fix
          enabled: true
          weight: 1
`,
    );
    const schedulerStore = new LoopSchedulerStore();
    const dispatchedKinds: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:15:00Z"),
      schedulerStore,
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      runSupervisorTask: async (request) => {
        dispatchedKinds.push(request.workOrder.task?.kind ?? "architecture");
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["harness-auto checked bug-fix scope"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"],
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(dispatchedKinds).toEqual(["harness-auto"]);
    expect(schedulerStore.getLastFired()).toMatchObject({
      "hub:harness-auto": scheduledAt,
      "hub:bug-fix": scheduledAt,
    });
    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-16"))).toContainEqual(
      expect.objectContaining({
        taskId: `loop:hub:bug-fix:${scheduledAt}`,
        status: "skipped",
        summary: "hub:harness-auto harness-auto covers bug-fix",
      }),
    );
  });

  it("defers overlapping workspace and child-project work without consuming the child schedule", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-workspace-conflict-state-"));
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-workspace-conflict-"));
    const backend = join(root, "geo-backend");
    const frontend = join(root, "geo-frontend");
    const configFile = join(root, "loop.yml");
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    writeFileSync(
      configFile,
      `
projects:
  - id: geo-backend
    name: Geo Backend
    path: ${backend}
    agent: codex
    goal: Fix backend bugs.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    runner:
      kind: agent-supervised
    execution:
      agent: true
    allowedActions: [tests]
    bugFix:
      enabled: true
      schedule: "10 10 * * *"
workspaces:
  - id: geo
    name: Geo Workspace
    root: ${root}
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: ${backend}
        role: backend
      - id: geo-frontend
        name: Geo Frontend
        path: ${frontend}
        role: frontend
    architecture:
      enabled: true
      schedule: "10 10 * * *"
      goal: Improve frontend/backend architecture together.
      runner:
        kind: agent-supervised
`,
    );
    const schedulerStore = new LoopSchedulerStore();
    const dispatchedIds: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:15:00Z"),
      schedulerStore,
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        dispatchedIds.push(request.workOrder.projectId);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["workspace architecture checked cross-repo contracts"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"],
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(dispatchedIds).toEqual(["geo"]);
    expect(schedulerStore.getLastFired()).toMatchObject({
      "workspace:geo:architecture": scheduledAt,
    });
    expect(schedulerStore.getLastFired()).not.toHaveProperty("geo-backend:bug-fix");
  });

  it("lets workspace harness-auto consume covered child-project subtasks in the same tick", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(
      join(tmpdir(), "tcb-loop-workspace-harness-conflict-state-"),
    );
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-workspace-harness-conflict-"));
    const backend = join(root, "geo-backend");
    const frontend = join(root, "geo-frontend");
    const configFile = join(root, "loop.yml");
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    writeFileSync(
      configFile,
      `
projects:
  - id: geo-backend
    name: Geo Backend
    path: ${backend}
    agent: codex
    goal: Fix backend bugs.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    runner:
      kind: agent-supervised
    execution:
      agent: true
    allowedActions: [tests]
    bugFix:
      enabled: true
      schedule: "10 10 * * *"
workspaces:
  - id: geo
    name: Geo Workspace
    root: ${root}
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: ${backend}
        role: backend
      - id: geo-frontend
        name: Geo Frontend
        path: ${frontend}
        role: frontend
    architecture:
      enabled: false
      goal: Improve frontend/backend architecture together.
    runner:
      kind: agent-supervised
    harnessAuto:
      enabled: true
      schedule: "10 10 * * *"
      tasks:
        - kind: bug-fix
          enabled: true
          weight: 1
`,
    );
    const schedulerStore = new LoopSchedulerStore();
    const dispatchedKinds: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:15:00Z"),
      schedulerStore,
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        dispatchedKinds.push(request.workOrder.task?.kind ?? "architecture");
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["workspace harness-auto checked child bug-fix scope"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"],
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(dispatchedKinds).toEqual(["harness-auto"]);
    expect(schedulerStore.getLastFired()).toMatchObject({
      "workspace:geo:harness-auto": scheduledAt,
      "geo-backend:bug-fix": scheduledAt,
    });
    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-16"))).toContainEqual(
      expect.objectContaining({
        taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
        status: "skipped",
        summary: "workspace:geo:harness-auto harness-auto covers bug-fix",
      }),
    );
  });

  it("does not dispatch new work to active supervisor sessions or active project paths", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const repoOne = mkdtempSync(join(tmpdir(), "tcb-loop-repo-one-"));
    const repoTwo = mkdtempSync(join(tmpdir(), "tcb-loop-repo-two-"));
    const configFile = writeRepositoryPrReviewConfig({ repoOne, repoTwo });
    const config = parseLoopConfigYaml(readFileSync(configFile, "utf8"));
    const activeRepository = config.prReview.repositories[0];
    if (activeRepository === undefined) throw new Error("missing repository");
    const activeWorkOrder = buildRepositoryPullRequestReviewWorkOrder({
      config,
      repository: activeRepository,
      scheduledAt: Date.parse("2026-07-16T10:05:00Z"),
      runId: "active-repo-one-prs",
    });
    writeLoopSupervisorWorkOrderState({
      workOrder: activeWorkOrder,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    const sessions: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("repository PR review should not call gh gates");
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        sessions.push(request.session);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["reviewed open pull requests"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"],
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(sessions).toEqual(["tmux_proj_loop-supervisor-2"]);
  });

  it("does not dispatch to supervisor sessions that are not idle", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const repoOne = mkdtempSync(join(tmpdir(), "tcb-loop-repo-one-"));
    const repoTwo = mkdtempSync(join(tmpdir(), "tcb-loop-repo-two-"));
    const configFile = writeRepositoryPrReviewConfig({ repoOne, repoTwo });
    const sessions: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("repository PR review should not call gh gates");
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        sessions.push(request.session);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: request.workOrder.projectId,
            actionsTaken: ["reviewed open pull requests"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionNames: ["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"],
      isSupervisorSessionAvailable: async (sessionName) =>
        sessionName === "tmux_proj_loop-supervisor-2",
    });

    expect(result).toMatchObject({ ran: 2, failed: 0 });
    expect(sessions).toEqual(["tmux_proj_loop-supervisor-2", "tmux_proj_loop-supervisor-2"]);
  });

  it("recovers interrupted repository PR review work orders from their final summary", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-repo-pr-review-"));
    const configText = `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
prReview:
  repositories:
    - id: mesh-talk-all-prs
      name: Mesh Talk PRs
      path: ${projectDir}
      repo: OctopusGarage/mesh-talk
      agent: codex
      schedule: "*/5 * * * *"
      base: dev
      switchBack: dev
      autoMerge: true
      runner:
        kind: agent-supervised
`;
    const configFile = join(projectDir, "loop.yml");
    writeFileSync(configFile, configText);
    const config = parseLoopConfigYaml(configText);
    const repository = config.prReview.repositories[0];
    if (repository === undefined) throw new Error("expected repository review config");
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    const workOrder = buildRepositoryPullRequestReviewWorkOrder({
      config,
      repository,
      scheduledAt,
      runId: `${scheduledAt}-mesh-talk-all-prs-repo-pr-review`,
    });
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "in-flight",
      now: scheduledAt + 1_000,
    });
    if (workOrder.finalSummaryPath === undefined) throw new Error("expected final summary path");
    writeFileSync(
      workOrder.finalSummaryPath,
      `${JSON.stringify({
        status: "blocked",
        projectId: "mesh-talk-all-prs",
        actionsTaken: ["found no openable synthetic project"],
        delegatedTasks: [],
        finalVerification: "not-run",
        commits: [],
        followUps: [],
      })}\n`,
    );
    const ledgerTaskId = `loop:pr-review:mesh-talk-all-prs:${scheduledAt}`;
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: ledgerTaskId,
      source: "loop-engineering",
      name: "mesh-talk-all-prs repository-pull-request-review",
      scheduledAt,
    });
    ledger.start(ledgerTaskId, scheduledAt + 1_000);

    const result = reconcileLoopSupervisorWorkOrders({
      configFile,
      now: scheduledAt + 2_000,
      runCommand: () => {
        throw new Error("blocked recovery should not run shell gates");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 1 });
    expect(new LoopSchedulerStore().getLastFired()).toMatchObject({
      "pr-review:mesh-talk-all-prs": scheduledAt,
    });
    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-16"))[0]).toMatchObject({
      taskId: ledgerTaskId,
      status: "failed",
      error: "blocked",
    });
  });

  it("reconciles active worker leases left behind by terminal completed work orders", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-repo-pr-review-"));
    const configText = `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
prReview:
  repositories:
    - id: mesh-talk-all-prs
      name: Mesh Talk PRs
      path: ${projectDir}
      repo: OctopusGarage/mesh-talk
      agent: codex
      schedule: "*/5 * * * *"
      base: dev
      switchBack: dev
      autoMerge: true
      runner:
        kind: agent-supervised
`;
    const configFile = join(projectDir, "loop.yml");
    writeFileSync(configFile, configText);
    const config = parseLoopConfigYaml(configText);
    const repository = config.prReview.repositories[0];
    if (repository === undefined) throw new Error("expected repository review config");
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    const workOrder = buildRepositoryPullRequestReviewWorkOrder({
      config,
      repository,
      scheduledAt,
      runId: `${scheduledAt}-mesh-talk-all-prs-repo-pr-review`,
    });
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "completed",
      now: scheduledAt + 1_000,
      resultStatus: "completed",
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor",
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          projectPath: workOrder.projectPath,
          status: "active",
          leasedAt: scheduledAt,
          updatedAt: scheduledAt + 1_000,
        },
      ],
    });

    const result = reconcileLoopSupervisorWorkOrders({
      configFile,
      now: scheduledAt + 2_000,
      runCommand: () => {
        throw new Error("terminal lease reconciliation should not run shell gates");
      },
    });

    expect(result).toEqual({ checked: 0, recovered: 0, failed: 0 });
    expect(readLoopSupervisorWorkerLeaseState()).toEqual({ leases: [] });
  });

  it("reconciles active worker leases left behind by abandoned invalid-output work orders", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-repo-pr-review-"));
    const configFile = join(projectDir, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
`,
    );
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    const workOrder = {
      id: `${scheduledAt}-hub-active-delegate`,
      scheduledAt,
      projectId: "hub",
      projectName: "Hub",
      projectPath: projectDir,
      agent: "codex",
      goal: "Keep the placeholder project valid.",
      maxRounds: 1,
      targetScore: 90,
      runner: { kind: "agent-supervised", timeoutMs: 1000, requireConfirmation: false },
      allowedActions: ["tests"],
      blockedActions: [],
      skills: { approved: [] },
      preflight: { commands: [], repair: { agent: false } },
      assessment: { command: "true" },
      execution: { agent: true },
      recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
      commitPolicy: { enabled: false, perRound: false },
      requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${scheduledAt}-hub-active-delegate]`,
      finalSummaryPath: join(
        process.env.TCB_STATE_DIR,
        "loop-runs",
        "hub",
        `${scheduledAt}-hub-active-delegate`,
        "supervisor-final-summary.json",
      ),
    } satisfies LoopWorkOrder;
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "in-flight",
      now: scheduledAt,
    });
    writeFileSync(workOrder.finalSummaryPath, '{"status":"completed"}\n');
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor",
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          projectPath: workOrder.projectPath,
          status: "active",
          leasedAt: scheduledAt,
          updatedAt: scheduledAt,
        },
      ],
    });

    const result = reconcileLoopSupervisorWorkOrders({
      configFile,
      now: scheduledAt + 10 * 60 * 1000,
      runCommand: () => {
        throw new Error("abandoned lease reconciliation should not run shell gates");
      },
    });

    expect(result).toEqual({ checked: 0, recovered: 0, failed: 0 });
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([
      expect.objectContaining({
        workOrderId: workOrder.id,
        status: "retained",
      }),
    ]);
  });

  it("does not require a loop commit branch for completed repository PR review merges", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-repo-pr-review-"));
    const configFile = join(projectDir, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
prReview:
  repositories:
    - id: net-auto-switch-all-prs
      name: Net Auto Switch PRs
      path: ${projectDir}
      repo: OctopusGarage/net-auto-switch
      agent: codex
      schedule: "*/5 * * * *"
      base: dev
      switchBack: dev
      autoMerge: true
      runner:
        kind: agent-supervised
`,
    );
    const gitInvocations: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("repository PR review system gate should not inspect a loop branch");
      },
      runGit: (invocation) => {
        gitInvocations.push(invocation.args.join(" "));
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "fetch origin dev") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "switch dev") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "merge --ff-only FETCH_HEAD") {
          return { status: 0, stdout: "Already up to date.\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: "net-auto-switch-all-prs",
            actionsTaken: ["merged eligible dependency PR"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: ["PR #24 merged into dev at abc123"],
            followUps: ["PR #23 remains conflicted"],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(gitInvocations).toEqual([
      "status --porcelain",
      "branch --show-current",
      "fetch origin dev",
      "switch dev",
      "merge --ff-only FETCH_HEAD",
    ]);
    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-16"))[0]).toMatchObject({
      taskId: `loop:pr-review:net-auto-switch-all-prs:${Date.parse("2026-07-16T10:10:00Z")}`,
      status: "success",
    });
  });

  it("fails a completed repository PR review when the switch-back branch cannot sync", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-repo-pr-review-"));
    const configFile = join(projectDir, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    goal: Keep the placeholder project valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
prReview:
  repositories:
    - id: mesh-talk-all-prs
      name: Mesh Talk PRs
      path: ${projectDir}
      repo: OctopusGarage/mesh-talk
      agent: codex
      schedule: "*/5 * * * *"
      base: dev
      switchBack: dev
      autoMerge: true
      runner:
        kind: agent-supervised
`,
    );

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("repository PR review system gate should not inspect a loop branch");
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "fetch origin dev") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "switch dev") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "merge --ff-only FETCH_HEAD") {
          return { status: 1, stdout: "", stderr: "fatal: Not possible to fast-forward" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: "mesh-talk-all-prs",
            actionsTaken: ["merged eligible PR"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: ["PR #17 merged into dev"],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 1 });
    const summary = readFileSync(
      supervisorSummaryPath(process.env.TCB_STATE_DIR, "mesh-talk-all-prs"),
      "utf8",
    );
    expect(summary).toContain("git merge --ff-only FETCH_HEAD failed");
    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-16"))[0]).toMatchObject({
      taskId: `loop:pr-review:mesh-talk-all-prs:${Date.parse("2026-07-16T10:10:00Z")}`,
      status: "failed",
    });
  });

  it("ensures the loop supervisor session before dispatching supervised work", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const ensureSupervisorSession = vi.fn(async () => true);

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
      ensureSupervisorSession,
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(ensureSupervisorSession).toHaveBeenCalledWith("tmux_proj_loop-supervisor");
  });

  it("re-ensures and retries once when supervisor dispatch fails readiness", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const ensureSupervisorSession = vi.fn(async () => true);
    const dispatches: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        dispatches.push(request.session);
        if (dispatches.length === 1) {
          return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
        }
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["retried supervisor dispatch"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
      ensureSupervisorSession,
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(dispatches).toEqual(["tmux_proj_loop-supervisor", "tmux_proj_loop-supervisor"]);
    expect(ensureSupervisorSession).toHaveBeenCalledTimes(2);
  });

  it("dispatches agent-supervised projects to the supervisor runner without running system commands", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const dispatched: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        expect(request.session).toBe("tmux_proj_loop-supervisor");
        expect(request.signal.aborted).toBe(false);
        dispatched.push(request.prompt);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("Loop Supervisor");
    expect(dispatched[0]).toContain('"projectId": "hub"');
    const summaryPath = supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub");
    expect(readFileSync(summaryPath, "utf8")).toContain('"status": "completed"');
    expect(
      JSON.parse(readFileSync(join(dirname(summaryPath), "system-gate.json"), "utf8")),
    ).toEqual(
      expect.objectContaining({
        workOrderId: `${Date.parse("2026-07-16T10:10:00Z")}-hub`,
        projectId: "hub",
        resultStatus: "completed",
        accepted: true,
        evidence: expect.arrayContaining(["no mutating git or PR gate required"]),
        failures: [],
      }),
    );
    expect(
      new DailyTaskLedger()
        .listForWindow(singaporeDayWindow("2026-07-16"))
        .map((record) => [record.taskId, record.status, record.source]),
    ).toEqual([[`loop:hub:${Date.parse("2026-07-16T10:10:00Z")}`, "success", "loop-engineering"]]);
  });

  it("dispatches scheduled bug-fix jobs as bug-fix work orders", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    bugFix:",
        "      enabled: true",
        '      schedule: "*/5 * * * *"',
        "      maxRounds: 2",
        "      maxBugsPerRound: 1",
      ].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const now = Date.parse("2026-07-16T10:10:00Z");
    schedulerStore.setLastFired("hub", now);

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now,
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        expect(request.workOrder.task).toMatchObject({
          kind: "bug-fix",
          maxRounds: 2,
          maxBugsPerRound: 1,
        });
        expect(request.prompt).toContain("Bug finding and repair task.");
        expect(request.prompt).toContain("Search for real bugs only");
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["no confirmed real bugs found"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 2, due: 1, ran: 1, failed: 0 });
    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-16"))[0]).toMatchObject({
      taskId: `loop:hub:bug-fix:${now}`,
      status: "success",
    });
  });

  it("does not require a loop-created PR for project pull-request-review jobs", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
        "    pullRequestReview:",
        "      enabled: true",
        '      schedule: "*/5 * * * *"',
        "      consecutivePasses: 2",
        "      autoMerge: true",
      ].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const now = Date.parse("2026-07-16T10:10:00Z");
    schedulerStore.setLastFired("hub", now);
    const prompts: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now,
      schedulerStore,
      runCommand: (invocation) => {
        throw new Error(
          `project PR review should not look up a loop-created PR: ${invocation.command}`,
        );
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        prompts.push(request.prompt);
        expect(request.workOrder.task).toMatchObject({ kind: "pull-request-review" });
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: "hub",
            actionsTaken: ["reviewed and merged eligible loop-created PRs"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: ["abc1234 merge reviewed PR"],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 2, due: 1, ran: 1, failed: 0 });
    expect(prompts).toHaveLength(1);
    expect(schedulerStore.getLastFired()).toHaveProperty("hub:pull-request-review", now);
  });

  it("syncs the switch-back branch after project pull-request-review auto-merge", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
        "      autoMerge: true",
        "    pullRequestReview:",
        "      enabled: true",
        '      schedule: "*/5 * * * *"',
        "      consecutivePasses: 2",
        "      autoMerge: true",
      ].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const now = Date.parse("2026-07-16T10:10:00Z");
    schedulerStore.setLastFired("hub", now);
    const gitInvocations: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now,
      schedulerStore,
      runCommand: (invocation) => {
        throw new Error(
          `project PR review should not look up a loop-created PR: ${invocation.command}`,
        );
      },
      runGit: (invocation) => {
        gitInvocations.push(invocation.args.join(" "));
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "fetch origin main") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "switch main") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "merge --ff-only FETCH_HEAD") {
          return { status: 0, stdout: "Already up to date.\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        expect(request.workOrder.task).toMatchObject({ kind: "pull-request-review" });
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: "hub",
            actionsTaken: ["reviewed and merged eligible loop-created PRs"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: ["abc1234 merge reviewed PR"],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 2, due: 1, ran: 1, failed: 0 });
    expect(gitInvocations).toEqual([
      "status --porcelain",
      "branch --show-current",
      "fetch origin main",
      "switch main",
      "merge --ff-only FETCH_HEAD",
    ]);
  });

  it("accepts a supervisor final summary written to the work order file", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        if (request.workOrder.finalSummaryPath === undefined) {
          throw new Error("expected final summary path");
        }
        writeFileSync(
          request.workOrder.finalSummaryPath,
          `${JSON.stringify({
            status: "completed",
            projectId: "hub",
            actionsTaken: ["wrote final summary file"],
            delegatedTasks: ["Round 1: verified a bounded slice"],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}\n`,
        );
        return {
          status: 0,
          stdout: `${request.workOrder.requiredFinalMarker}\n{"status":"completed"`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    const summary = readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8");
    expect(summary).toContain("wrote final summary file");
    expect(summary).toContain("Round 1: verified a bounded slice");
  });

  it("does not consume a scheduled fire when the supervisor summary is invalid", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const now = Date.parse("2026-07-16T10:10:00Z");

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now,
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => ({
        status: 0,
        stdout: `${request.workOrder.requiredFinalMarker}\n{"status":"completed","projectId":"hub","actionsTaken":["ran"],"delegatedTasks":[{}],"finalVerification":"passed","commits":[],"followUps":[]}`,
        stderr: "",
      }),
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 1 });
    expect(schedulerStore.getLastFired()).not.toHaveProperty("hub");
    const runDir = join(process.env.TCB_STATE_DIR, "loop-runs", "hub", "1784196600000-hub");
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "failed"',
    );
  });

  it("asks the supervisor to revise recoverable system gate failures before completing", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: ["    commit:", "      enabled: true", "      branch: loop/hub/test"].join(
        "\n",
      ),
    });
    const schedulerStore = new LoopSchedulerStore();
    const prompts: string[] = [];
    let gateAttempt = 0;

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("PR commands should not run without pullRequest.enabled");
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          gateAttempt += 1;
          return gateAttempt === 1
            ? { status: 0, stdout: " M src/dirty.ts\n", stderr: "" }
            : { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        prompts.push(request.prompt);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: "hub",
            actionsTaken: [
              prompts.length === 1 ? "left a dirty worktree" : "cleaned the target worktree",
            ],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
      supervisorRevisionMaxAttempts: 2,
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("System validation failed");
    expect(prompts[1]).toContain("worktree is dirty after supervisor completion");
    expect(schedulerStore.getLastFired()).toHaveProperty("hub", Date.parse("2026-07-16T10:10:00Z"));
    const runDir = join(process.env.TCB_STATE_DIR, "loop-runs", "hub", "1784196600000-hub");
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("fails after bounded supervisor revision attempts are exhausted", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: ["    commit:", "      enabled: true", "      branch: loop/hub/test"].join(
        "\n",
      ),
    });
    const schedulerStore = new LoopSchedulerStore();
    const prompts: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("PR commands should not run without pullRequest.enabled");
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: " M src/dirty.ts\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        prompts.push(request.prompt);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n${JSON.stringify({
            status: "completed",
            projectId: "hub",
            actionsTaken: ["still dirty"],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
      supervisorRevisionMaxAttempts: 2,
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 1 });
    expect(prompts).toHaveLength(3);
    expect(prompts.slice(1).every((prompt) => prompt.includes("System validation failed"))).toBe(
      true,
    );
    expect(schedulerStore.getLastFired()).toHaveProperty("hub", Date.parse("2026-07-16T10:10:00Z"));
    const summary = readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8");
    expect(summary).toContain('"status": "supervisor-failed"');
    expect(summary).toContain("worktree is dirty after supervisor completion");
  });

  it("keeps system projects on the system runner", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({ projectPath: projectDir });
    const invocations: LoopRunCommandInvocation[] = [];
    const runSupervisorTask = vi.fn(async () => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        invocations.push(invocation);
        return { status: 0, stdout: JSON.stringify({ findings: [] }), stderr: "" };
      },
      runSupervisorTask,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    expect(invocations.map((invocation) => invocation.kind)).toEqual(["assessment"]);
    expect(runSupervisorTask).not.toHaveBeenCalled();
  });

  it("counts supervised invalid output as failed and writes the supervisor report", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    const staleRunDir = join(process.env.TCB_STATE_DIR, "loop-runs", "hub", `${scheduledAt}-hub`);
    mkdirSync(staleRunDir, { recursive: true });
    writeFileSync(
      join(staleRunDir, "supervisor-final-summary.json"),
      '{"status":"completed","projectId":"hub","actionsTaken":["stale"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}\n',
    );
    writeFileSync(
      join(staleRunDir, "system-gate.json"),
      '{"resultStatus":"completed","accepted":true}\n',
    );

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: scheduledAt,
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async () => ({
        status: 0,
        stdout: "done without final marker",
        stderr: "",
      }),
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 1 });
    expect(readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8")).toContain(
      '"status": "invalid-output"',
    );
    expect(JSON.parse(readFileSync(join(staleRunDir, "system-gate.json"), "utf8"))).toMatchObject({
      resultStatus: "invalid-output",
      accepted: false,
    });
    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-16"))[0]).toMatchObject({
      taskId: `loop:hub:${scheduledAt}`,
      source: "loop-engineering",
      status: "failed",
      error: "invalid-output",
    });
  });

  it("retries the same scheduled fire when the supervisor session is not live", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const dispatch = vi.fn(async () => ({
      status: 1,
      stdout: "",
      stderr: 'no live loop supervisor session "tmux_proj_loop-supervisor"',
    }));

    const first = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });
    const second = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(first).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(second).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("retries the same scheduled fire when the supervisor is not ready", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const dispatch = vi.fn(async () => ({
      status: 1,
      stdout: "",
      stderr: "Codex did not become ready in time",
    }));

    const first = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });
    const second = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(first).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(second).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("retries the same scheduled fire when supervisor output misses the final marker", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const dispatch = vi.fn(async () => ({
      status: 0,
      stdout: "target agent is still finishing and no marker is available",
      stderr: "",
    }));

    const first = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });
    const second = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(first).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(second).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("does not restore a retryable failure over a newer scheduler anchor", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const nextAnchor = Date.parse("2026-07-16T10:15:00Z");
    const dispatch = vi.fn(async () => {
      schedulerStore.setLastFired("hub", nextAnchor);
      return {
        status: 1,
        stdout: "",
        stderr: 'no live loop supervisor session "tmux_proj_loop-supervisor"',
      };
    });

    await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });
    const second = await runLoopServiceTickAsync({
      configFile: file,
      now: nextAnchor,
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(second).toMatchObject({ due: 0, ran: 0, failed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("records supervisor follow-ups in the loop backlog", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":["Review supervisor logs weekly"]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ failed: 0 });
    expect(new LoopBacklogStore().list()).toEqual([
      expect.objectContaining({
        projectId: "hub",
        text: "Review supervisor logs weekly",
      }),
    ]);
  });

  it("fails a completed supervised run when the system PR gate reports conflicts", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
      ].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        expect(invocation.kind).toBe("pr");
        return {
          status: 0,
          stdout: JSON.stringify({
            url: "https://github.com/acme/hub/pull/1",
            state: "OPEN",
            mergeable: "CONFLICTING",
            statusCheckRollup: [],
          }),
          stderr: "",
        };
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["opened PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 1 });
    expect(readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8")).toContain(
      "PR is not mergeable: CONFLICTING",
    );
  });

  it("fails before PR lookup when the configured GitHub account lacks write access", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
        "      githubAccount: example-maintainer",
      ].join("\n"),
    });
    const prCommands: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        prCommands.push(invocation.command);
        return { status: 0, stdout: JSON.stringify({ viewerPermission: "READ" }), stderr: "" };
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["pushed branch"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 1 });
    expect(prCommands).toEqual([
      "GH_TOKEN=\"$(gh auth token --user 'example-maintainer')\" gh repo view --json viewerPermission",
    ]);
    expect(readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8")).toContain(
      "GitHub account example-maintainer has READ permission",
    );
  });

  it("does not inspect an old PR when supervised work completes with no commits", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
      ].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("PR lookup should not run without supervisor commits");
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["score reached target"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
  });

  it("fails a completed supervised run when the PR contains stale commits", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
      ].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/acme/hub/pull/1",
          state: "OPEN",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
          body: "## Summary\n- Clean architecture docs.",
          files: [{ path: "README.md" }],
          commits: [{ oid: "old999" }, { oid: "abc123" }],
        }),
        stderr: "",
      }),
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only abc123") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["opened PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 1 });
    const summary = readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8");
    expect(summary).toContain("unexpected PR commit count: expected 1, got 2");
    expect(summary).toContain("PR contains commit outside supervisor summary: old999");
  });

  it("accepts human-readable supervisor commits and ignores the merged PR commit", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: dev",
        "      switchBack: dev",
      ].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/acme/hub/pull/1",
          state: "MERGED",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
          body: "## Summary\n- Clean architecture slices.",
          files: [{ path: "README.md" }, { path: "src/planner.ts" }],
          commits: [
            { oid: "d1774c14efe74c881f425074150e931d5e3384d1" },
            { oid: "ecdbef2b9dbf6e9f4a86d63100879cdc73aade89" },
          ],
          mergeCommit: { oid: "5a2ba869c37da0fa365e9b2d25cc528456332972" },
        }),
        stderr: "",
      }),
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only d1774c1") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only ecdbef2") {
          return { status: 0, stdout: "src/planner.ts\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["merged PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["d1774c1 refactor: centralize routine schedule planning","ecdbef2 refactor: centralize radar report selection","5a2ba86 Refactor Alcove architecture slices (#11)","PR #15 opened and green: https://github.com/acme/hub/pull/15"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
  });

  it("fails a completed supervised run when the PR contains files outside supervisor commits", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
      ].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/acme/hub/pull/1",
          state: "OPEN",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
          body: "## Summary\n- Clean architecture docs.",
          files: [{ path: "README.md" }, { path: "docs/stale.md" }],
          commits: [{ oid: "abc123" }],
        }),
        stderr: "",
      }),
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only abc123") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["opened PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 1 });
    expect(readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8")).toContain(
      "PR contains files not produced by supervisor commits: docs/stale.md",
    );
  });

  it("cleans generated review noise from a completed supervised PR body before gating", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
      ].join("\n"),
    });
    const prCommands: string[] = [];
    let body =
      "## Summary\n- Clean architecture docs.\n\n<!-- This is an auto-generated comment: release notes by coderabbit.ai -->\n\n## Summary by CodeRabbit\n\n* Tests changed.\n\n<!-- end of auto-generated comment: release notes by coderabbit.ai -->\n";

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        prCommands.push(invocation.command);
        if (invocation.command.includes("gh pr edit ")) {
          const bodyFile = invocation.command.match(/--body-file '([^']+)'/)?.[1];
          if (bodyFile === undefined) throw new Error("missing body file");
          body = readFileSync(bodyFile, "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            url: "https://github.com/acme/hub/pull/1",
            state: "OPEN",
            mergeable: "MERGEABLE",
            statusCheckRollup: [],
            body,
            files: [{ path: "README.md" }],
            commits: [{ oid: "abc123" }],
          }),
          stderr: "",
        };
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only abc123") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["opened PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(body).toBe("## Summary\n- Clean architecture docs.\n");
    expect(prCommands).toEqual([
      "gh pr view 'loop/hub/architecture/1784196600000-hub' --json url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
      expect.stringMatching(
        /^gh pr edit 'loop\/hub\/architecture\/1784196600000-hub' --body-file '.+hub-\d+\.md'$/,
      ),
      "gh pr view 'loop/hub/architecture/1784196600000-hub' --json url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
    ]);
  });

  it("waits for pending supervised PR checks before marking the run successful", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    process.env.TCB_LOOP_PR_CHECK_POLL_ATTEMPTS = "2";
    process.env.TCB_LOOP_PR_CHECK_POLL_INTERVAL_SECONDS = "1";
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
      ].join("\n"),
    });
    const prCommands: string[] = [];
    let prLookups = 0;

    try {
      const result = await runLoopServiceTickAsync({
        configFile: file,
        now: Date.parse("2026-07-16T10:10:00Z"),
        schedulerStore: new LoopSchedulerStore(),
        runCommand: (invocation) => {
          prCommands.push(invocation.command);
          if (invocation.command.startsWith("sleep ")) {
            return { status: 0, stdout: "", stderr: "" };
          }
          prLookups += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              url: "https://github.com/acme/hub/pull/1",
              state: "OPEN",
              mergeable: "MERGEABLE",
              statusCheckRollup:
                prLookups === 1
                  ? [{ name: "ci", status: "IN_PROGRESS", conclusion: "" }]
                  : [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
              body: "## Summary\n- Clean architecture docs.",
              files: [{ path: "README.md" }],
              commits: [{ oid: "abc123" }],
            }),
            stderr: "",
          };
        },
        runGit: (invocation) => {
          if (invocation.args.join(" ") === "status --porcelain") {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (invocation.args.join(" ") === "branch --show-current") {
            return { status: 0, stdout: "main\n", stderr: "" };
          }
          if (invocation.args.join(" ") === "show --format= --name-only abc123") {
            return { status: 0, stdout: "README.md\n", stderr: "" };
          }
          throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
        },
        runSupervisorTask: async (request) => {
          const marker = finalMarkerFromPrompt(request.prompt);
          return {
            status: 0,
            stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["opened PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
            stderr: "",
          };
        },
        supervisorSessionName: "tmux_proj_loop-supervisor",
      });

      expect(result).toMatchObject({ ran: 1, failed: 0 });
      expect(prCommands).toEqual([
        "gh pr view 'loop/hub/architecture/1784196600000-hub' --json url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
        "sleep 1",
        "gh pr view 'loop/hub/architecture/1784196600000-hub' --json url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
      ]);
    } finally {
      delete process.env.TCB_LOOP_PR_CHECK_POLL_ATTEMPTS;
      delete process.env.TCB_LOOP_PR_CHECK_POLL_INTERVAL_SECONDS;
    }
  });

  it("does not fail a completed supervised run for post-merge advisory check failures", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: dev",
        "      switchBack: dev",
        "      autoMerge: true",
      ].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        if (invocation.command.includes("gh pr merge ")) {
          return { status: 0, stdout: "Merged pull request #1", stderr: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            url: "https://github.com/acme/hub/pull/1",
            state: "MERGED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [
              { name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "codecov/patch", status: "COMPLETED", conclusion: "FAILURE" },
            ],
            body: "## Summary\n- Clean architecture docs.",
            files: [{ path: "README.md" }],
            commits: [{ oid: "abc123" }],
            mergeCommit: { oid: "def456" },
          }),
          stderr: "",
        };
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only abc123") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["opened and merged PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
  });

  it("auto-merges a completed supervised PR into the configured branch and updates it locally", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: dev",
        "      switchBack: dev",
        "      autoMerge: true",
        "      mergeMethod: merge",
        "      githubAccount: example-owner",
      ].join("\n"),
    });
    const prCommands: string[] = [];
    const gitCommands: string[][] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        expect(invocation.kind).toBe("pr");
        prCommands.push(invocation.command);
        if (invocation.command.includes("gh repo view --json viewerPermission")) {
          return { status: 0, stdout: JSON.stringify({ viewerPermission: "ADMIN" }), stderr: "" };
        }
        if (invocation.command.includes(" gh pr view ")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              url: "https://github.com/acme/hub/pull/1",
              state: "OPEN",
              mergeable: "MERGEABLE",
              statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
              body: "## Summary\n- Clean architecture docs.",
              files: [{ path: "README.md" }],
              commits: [{ oid: "abc123" }],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "Merged pull request #1", stderr: "" };
      },
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only abc123") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runSupervisorTask: async (request) => {
        expect(request.prompt).toContain('"base": "dev"');
        expect(request.prompt).toContain('"switchBack": "dev"');
        expect(request.prompt).toContain('"autoMerge": true');
        expect(request.prompt).toContain('"mergeMethod": "merge"');
        expect(request.prompt).toContain('"githubAccount": "example-owner"');
        expect(request.prompt).toContain("gh auth token --user 'example-owner'");
        expect(request.prompt).toContain('"branch": "loop/hub/architecture/1784196600000-hub"');
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["opened PR"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(prCommands).toEqual([
      "GH_TOKEN=\"$(gh auth token --user 'example-owner')\" gh repo view --json viewerPermission",
      "GH_TOKEN=\"$(gh auth token --user 'example-owner')\" gh pr view 'loop/hub/architecture/1784196600000-hub' --json url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
      "GH_TOKEN=\"$(gh auth token --user 'example-owner')\" gh pr merge 'loop/hub/architecture/1784196600000-hub' --merge --delete-branch",
    ]);
    expect(gitCommands).toEqual([
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      ["show", "--format=", "--name-only", "abc123"],
      ["fetch", "origin", "dev"],
      ["switch", "dev"],
      ["merge", "--ff-only", "FETCH_HEAD"],
    ]);
  });

  it("dispatches supervised single-repository work from an isolated git worktree", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    mkdirSync(join(projectDir, ".git"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
      projectExtra: [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: dev",
        "      switchBack: dev",
        "      autoMerge: false",
      ].join("\n"),
    });
    const expectedWorktree = join(stateDir, "loop-worktrees", "hub", "1784196600000-hub");
    const gitCommands: Array<{ cwd: string; args: string[] }> = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      runGit: (invocation) => {
        gitCommands.push(invocation);
        const command = invocation.args.join(" ");
        if (invocation.cwd === projectDir && command === "rev-parse --show-toplevel") {
          return { status: 0, stdout: `${projectDir}\n`, stderr: "" };
        }
        if (invocation.cwd === expectedWorktree && command === "rev-parse --show-toplevel") {
          return { status: 1, stdout: "", stderr: "not a git repository" };
        }
        if (
          invocation.cwd === projectDir &&
          command === `worktree add --detach ${expectedWorktree} HEAD`
        ) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runSupervisorTask: async (request) => {
        expect(request.workOrder.projectPath).toBe(expectedWorktree);
        expect(request.workOrder.executionIsolation).toMatchObject({
          expectedWorktree,
          sourceWorktree: projectDir,
          preparedBy: "system-git-worktree",
        });
        expect(request.prompt).toContain(`"projectPath": "${expectedWorktree}"`);
        expect(request.prompt).toContain(`Original project worktree: ${projectDir}`);
        expect(request.prompt).toContain("open-worker 'tmux_proj_loop-worker-hub-");
        expect(request.prompt).toContain(`'${expectedWorktree}' --agent codex`);
        expect(request.prompt).toContain(`git -C '${expectedWorktree}' switch --detach origin/dev`);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":["no changes"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
      projectSessionPrefix: "tmux_proj_",
    });

    expect(result).toMatchObject({ ran: 1, failed: 0 });
    expect(gitCommands).toContainEqual({
      cwd: projectDir,
      args: ["worktree", "add", "--detach", expectedWorktree, "HEAD"],
    });
    expect(gitCommands).toContainEqual({ cwd: expectedWorktree, args: ["status", "--porcelain"] });
    expect(gitCommands).toContainEqual({ cwd: projectDir, args: ["branch", "--show-current"] });
  });

  it("does not overlap managed ticks while a supervisor run is still in flight", async () => {
    vi.useFakeTimers();
    try {
      process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
      const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
      const file = writeLoopConfig({
        projectPath: projectDir,
        runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 60000"].join(
          "\n",
        ),
      });
      vi.setSystemTime(new Date("2026-07-16T10:10:00Z"));
      const enqueue = vi.fn(() => "queued" as const);
      const stop = startLoopEngineering(
        {
          config: {
            projectSessionPrefix: "tmux_proj_",
            maxWaitDoneTotalMs: 60_000,
            loopEngineering: {
              configFile: file,
              tickMs: 1000,
              supervisor: { enabled: false, dir: "", agent: "codex" },
            },
          },
          bridge: {
            hasSession: vi.fn(async () => true),
          },
          queue: {
            enqueue,
            cancelQueued: vi.fn(() => false),
            loadPersisted: vi.fn(() => []),
            keepPersistedCarryover: vi.fn(),
          },
        } as never,
        { configFile: file, tickMs: 1000 },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(enqueue).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(enqueue).toHaveBeenCalledTimes(1);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
