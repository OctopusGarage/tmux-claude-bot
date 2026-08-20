import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCapacityStore } from "../../src/core/automation/capacity-store.js";
import { autonomousCapacityLeaseId } from "../../src/core/automation/coordinator.js";
import { listLoopReports } from "../../src/core/loop/report.js";
import {
  reconcileAutonomousCapacityLeases,
  reconcileLoopSupervisorWorkOrders,
} from "../../src/core/loop/service.js";
import {
  readLoopSupervisorWorkerLeaseState,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import {
  readLoopSupervisorWorkOrderRegistry,
  writeLoopSupervisorWorkOrderState,
} from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { DailyTaskLedger, singaporeDayWindow } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function writeConfig(projectPath: string, projectExtra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-config-"));
  const file = join(dir, "loop.yml");
  writeFileSync(
    file,
    `
projects:
  - id: hub
    name: Hub
    path: ${projectPath}
    agent: codex
    schedule: "*/5 * * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 1000
    goal: Improve architecture in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
${projectExtra}
    allowedActions: [tests]
`,
  );
  return file;
}

function workOrder(stateDir: string, projectPath: string): LoopWorkOrder {
  const runId = "1784196600000-hub";
  return {
    id: runId,
    scheduledAt: 1_784_196_600_000,
    projectId: "hub",
    projectName: "Hub",
    projectPath,
    agent: "codex",
    goal: "Improve architecture in small verified slices.",
    maxRounds: 1,
    targetScore: 90,
    runner: { kind: "agent-supervised", timeoutMs: 1000, requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "npm run assess" },
    execution: { agent: true },
    recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: true },
    pullRequestPolicy: {
      enabled: false,
      base: "main",
      switchBack: "main",
      autoMerge: false,
      mergeMethod: "squash",
    },
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${runId}]`,
    finalSummaryPath: join(stateDir, "loop-runs", "hub", runId, "supervisor-final-summary.json"),
  };
}

function writeUnfinishedRun(stateDir: string, order: LoopWorkOrder): string {
  const runDir = join(stateDir, "loop-runs", "hub", order.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "work-order.json"), `${JSON.stringify(order, null, 2)}\n`);
  writeFileSync(
    join(runDir, "work-order-state.json"),
    `${JSON.stringify(
      {
        status: "in-flight",
        projectId: "hub",
        runId: order.id,
        supervisorSession: "tmux_proj_loop-supervisor",
        scheduledAt: order.scheduledAt,
        updatedAt: 1_000,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    order.finalSummaryPath ?? "",
    `${JSON.stringify({
      status: "completed",
      projectId: "hub",
      actionsTaken: ["finished before restart"],
      delegatedTasks: ["Round 1: deepened a module"],
      finalVerification: "passed",
      commits: order.commitPolicy.enabled ? ["abc123 refactor: deepen module"] : [],
      followUps: ["Keep an eye on the next scheduled run"],
    })}\n`,
  );
  return runDir;
}

function writeRecoverableFailedRun(stateDir: string, order: LoopWorkOrder): string {
  const runDir = writeUnfinishedRun(stateDir, order);
  writeFileSync(
    join(runDir, "work-order-state.json"),
    `${JSON.stringify(
      {
        status: "failed",
        resultStatus: "dispatch-failed",
        projectId: "hub",
        runId: order.id,
        supervisorSession: "tmux_proj_loop-supervisor",
        scheduledAt: order.scheduledAt,
        updatedAt: 1_000,
      },
      null,
      2,
    )}\n`,
  );
  return runDir;
}

describe("loop supervisor work order reconciliation", () => {
  it("releases stale autonomous capacity leases for terminal work orders", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const activeOrder = workOrder(stateDir, projectDir);
    const terminalOrder: LoopWorkOrder = {
      ...workOrder(stateDir, projectDir),
      id: "1784196900000-hub",
      scheduledAt: 1_784_196_900_000,
      finalSummaryPath: join(
        stateDir,
        "loop-runs",
        "hub",
        "1784196900000-hub",
        "supervisor-final-summary.json",
      ),
    };
    writeUnfinishedRun(stateDir, activeOrder);
    rmSync(activeOrder.finalSummaryPath ?? "", { force: true });
    writeUnfinishedRun(stateDir, terminalOrder);
    writeLoopSupervisorWorkOrderState({
      workOrder: terminalOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "completed",
      now: 2_000,
      resultStatus: "completed",
    });

    const capacity = new AgentCapacityStore();
    capacity.recordObservation({
      agent: "codex",
      authentication: "subscription",
      state: "unknown",
      fiveHourPct: null,
      weeklyPct: null,
      resetAt: null,
      observedAt: 1_000,
      nextProbeAt: 10_000,
      latestReason: "usage-telemetry-unavailable",
    });
    const activeLeaseId = autonomousCapacityLeaseId({
      source: "loop-engineering",
      id: `${activeOrder.projectId}:${activeOrder.scheduledAt}`,
    });
    const terminalLeaseId = autonomousCapacityLeaseId({
      source: "loop-engineering",
      id: `${terminalOrder.projectId}:${terminalOrder.scheduledAt}`,
    });
    const runtimeGuardianLeaseId = autonomousCapacityLeaseId({
      source: "runtime-guardian",
      id: "live-runtime-repair",
    });
    expect(capacity.acquireLease("codex", activeLeaseId, 1_000, 10_000)).toBe(true);
    expect(capacity.acquireLease("codex", terminalLeaseId, 1_000, 10_000)).toBe(true);
    expect(capacity.acquireLease("codex", runtimeGuardianLeaseId, 1_000, 10_000)).toBe(true);
    expect(capacity.acquireLease("codex", "expired", 1_000, 100)).toBe(true);

    expect(reconcileAutonomousCapacityLeases(capacity, 2_000)).toBe(2);

    expect(capacity.hasLease("codex", activeLeaseId, 2_000)).toBe(true);
    expect(capacity.hasLease("codex", terminalLeaseId, 2_000)).toBe(false);
    expect(capacity.hasLease("codex", runtimeGuardianLeaseId, 2_000)).toBe(true);
    expect(capacity.read("codex", 2_000).activeAutonomousLeases).toBe(2);
  });

  it("does not classify a recoverable final summary as abandoned", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const order = workOrder(stateDir, projectDir);
    writeUnfinishedRun(stateDir, order);

    const registry = readLoopSupervisorWorkOrderRegistry(Date.now() + 24 * 60 * 60_000);

    expect(registry.recoverableFinalSummary.map((record) => record.workOrder.id)).toContain(
      order.id,
    );
    expect(registry.abandoned.map((record) => record.workOrder.id)).not.toContain(order.id);
  });

  it("completes an in-flight work order from the final summary file after a bot restart", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(projectDir);
    const order = workOrder(stateDir, projectDir);
    const runDir = writeUnfinishedRun(stateDir, order);

    expect(readLoopSupervisorWorkOrderRegistry(2_000).recoverableFinalSummary).toEqual([
      expect.objectContaining({ workOrder: expect.objectContaining({ id: order.id }) }),
    ]);

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("PR commands should not run without supervisor commits");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(listLoopReports()).toEqual([
      expect.objectContaining({
        runId: order.id,
        projectId: "hub",
        status: "passed",
        startedAt: 1_000,
        endedAt: 2_000,
      }),
    ]);
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("does not recover final-summary evidence while its supervisor prompt is still active", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(projectDir);
    const order = workOrder(stateDir, projectDir);
    const runDir = writeUnfinishedRun(stateDir, order);
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor",
          workOrderId: order.id,
          projectId: order.projectId,
          projectPath: order.projectPath,
          status: "active",
          leasedAt: 1_000,
          updatedAt: 1_000,
        },
      ],
    });

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("active supervisor work must remain authoritative");
      },
      supervisorSessionBusy: () => true,
    });

    expect(result).toEqual({ checked: 0, recovered: 0, failed: 0 });
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "in-flight"',
    );
    expect(listLoopReports()).toEqual([]);
  });

  it("recovers a dispatch-failed work order when the supervisor final summary arrives late", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(projectDir);
    const order = workOrder(stateDir, projectDir);
    const runDir = writeRecoverableFailedRun(stateDir, order);

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("PR commands should not run without supervisor commits");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("does not reprocess a terminal failed work order after system-gate evidence is durable", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const order = workOrder(stateDir, projectDir);
    const runDir = writeRecoverableFailedRun(stateDir, order);
    writeFileSync(
      join(runDir, "system-gate.json"),
      `${JSON.stringify({ accepted: false, resultStatus: "supervisor-failed" })}\n`,
    );

    expect(readLoopSupervisorWorkOrderRegistry(2_000).recoverableFailed).toEqual([]);
  });

  it("fails and records a stale dispatching work order even when its lease is already gone", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(projectDir);
    const order = {
      ...workOrder(stateDir, projectDir),
      task: { kind: "test-coverage" },
      finalSummaryPath: join(
        stateDir,
        "loop-runs",
        "hub",
        "1784196600000-hub",
        "supervisor-final-summary.json",
      ),
    } as unknown as LoopWorkOrder;
    const runDir = join(stateDir, "loop-runs", "hub", order.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "work-order.json"), `${JSON.stringify(order, null, 2)}\n`);
    writeFileSync(
      join(runDir, "work-order-state.json"),
      `${JSON.stringify(
        {
          status: "dispatching",
          projectId: "hub",
          runId: order.id,
          supervisorSession: "tmux_proj_loop-supervisor",
          scheduledAt: order.scheduledAt,
          updatedAt: 1_000,
        },
        null,
      )}\n`,
    );

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 1_000 + 12 * 60 * 60 * 1000 + 1,
      runCommand: () => {
        throw new Error("stale dispatching work orders must not run project commands");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 0, failed: 1 });
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "failed"',
    );
    expect(new DailyTaskLedger().listAll()).toEqual([
      expect.objectContaining({
        taskId: "loop:hub:test-coverage:1784196600000",
        status: "failed",
        repairStatus: "pending",
      }),
    ]);
  });

  it("fails a dispatching work order after the short dispatch grace period", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(projectDir);
    const order = {
      ...workOrder(stateDir, projectDir),
      task: { kind: "security-maintenance" },
    } as unknown as LoopWorkOrder;
    const now = Date.now();
    const dispatchStartedAt = now - 5 * 60 * 1000 - 1;
    const runDir = join(stateDir, "loop-runs", "hub", order.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "work-order.json"), `${JSON.stringify(order, null, 2)}\n`);
    writeFileSync(
      join(runDir, "work-order-state.json"),
      `${JSON.stringify(
        {
          status: "dispatching",
          projectId: "hub",
          runId: order.id,
          supervisorSession: "tmux_proj_loop-supervisor-1",
          scheduledAt: order.scheduledAt,
          updatedAt: dispatchStartedAt,
        },
        null,
      )}\n`,
    );

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now,
      runCommand: () => {
        throw new Error("stale dispatching work orders must not run project commands");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 1 });
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "failed"',
    );
  });

  it("recovers a stale dispatching work order even when its supervisor lease leaked", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(projectDir);
    const order = {
      ...workOrder(stateDir, projectDir),
      task: { kind: "security-maintenance" },
    } as unknown as LoopWorkOrder;
    const now = Date.now();
    const runDir = join(stateDir, "loop-runs", "hub", order.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "work-order.json"), `${JSON.stringify(order, null, 2)}\n`);
    writeFileSync(
      join(runDir, "work-order-state.json"),
      `${JSON.stringify(
        {
          status: "dispatching",
          projectId: "hub",
          runId: order.id,
          supervisorSession: "tmux_proj_loop-supervisor-1",
          scheduledAt: order.scheduledAt,
          updatedAt: now - 5 * 60 * 1000 - 1,
        },
        null,
      )}\n`,
    );
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor-1",
          workOrderId: order.id,
          projectId: order.projectId,
          projectPath: order.projectPath,
          status: "active",
          leasedAt: now - 5 * 60 * 1000,
          updatedAt: now - 5 * 60 * 1000,
        },
      ],
    });

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now,
      runCommand: () => {
        throw new Error("stale dispatching work orders must not run project commands");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 1 });
    expect(JSON.parse(readFileSync(join(runDir, "work-order-state.json"), "utf8"))).toEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([
      expect.objectContaining({ workOrderId: order.id, status: "retained" }),
    ]);
  });

  it("runs the supervised PR gate when reconciling a completed work order", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(
      projectDir,
      [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: dev",
        "      switchBack: dev",
      ].join("\n"),
    );
    const order = {
      ...workOrder(stateDir, projectDir),
      commitPolicy: {
        enabled: true,
        perRound: true,
        branch: "loop/hub/architecture/1784196600000-hub",
      },
      pullRequestPolicy: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: false,
        mergeMethod: "squash" as const,
      },
    } satisfies LoopWorkOrder;
    const runDir = writeUnfinishedRun(stateDir, order);
    const prCommands: string[] = [];

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: (invocation) => {
        prCommands.push(invocation.command);
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            mergeable: "MERGEABLE",
            statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
            body: "## Summary\n- Deepened one module.",
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
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only abc123") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(prCommands).toEqual([
      "gh pr view 'loop/hub/architecture/1784196600000-hub' --json url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
    ]);
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("reconciles opportunity discovery work orders without PR gates", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(
      projectDir,
      [
        "    opportunityDiscovery:",
        "      enabled: true",
        '      schedule: "*/5 * * * *"',
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: dev",
        "      switchBack: dev",
      ].join("\n"),
    );
    const order = {
      ...workOrder(stateDir, projectDir),
      id: "1784196600000-hub-opportunity-discovery",
      task: {
        kind: "opportunity-discovery",
        maxRounds: 1,
        maxSuggestions: 3,
        minConfidence: "medium",
        categories: ["product-feature"],
        cooldownDays: 14,
        requireEvidence: true,
      },
      commitPolicy: {
        enabled: true,
        perRound: true,
        branch: "loop/hub/architecture/1784196600000-hub-opportunity-discovery",
      },
      pullRequestPolicy: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: true,
        mergeMethod: "squash" as const,
      },
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1784196600000-hub-opportunity-discovery]",
      finalSummaryPath: join(
        stateDir,
        "loop-runs",
        "hub",
        "1784196600000-hub-opportunity-discovery",
        "supervisor-final-summary.json",
      ),
    } satisfies LoopWorkOrder;
    const runDir = writeUnfinishedRun(stateDir, order);
    writeFileSync(
      order.finalSummaryPath ?? "",
      `${JSON.stringify({
        status: "completed",
        projectId: "hub",
        actionsTaken: ["wrote opportunity report"],
        delegatedTasks: [
          {
            projectId: "hub",
            status: "interrupted-read-only-discovery-after-local-report-completed",
          },
        ],
        finalVerification: "passed",
        commits: [],
        followUps: ["Discuss suggestions before delegating implementation"],
      })}\n`,
    );

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("PR commands should not run for opportunity discovery");
      },
      runGit: () => {
        throw new Error("git gates should not run for opportunity discovery");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("reconciles bug-fix work orders with the bug-fix scheduler key", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(
      projectDir,
      [
        "    bugFix:",
        "      enabled: true",
        '      schedule: "*/5 * * * *"',
        "      maxRounds: 2",
        "      maxBugsPerRound: 1",
      ].join("\n"),
    );
    const order = {
      ...workOrder(stateDir, projectDir),
      id: "1784196600000-hub-bug-fix",
      task: {
        kind: "bug-fix",
        maxRounds: 2,
        maxBugsPerRound: 1,
        requireRegressionTest: true,
      },
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1784196600000-hub-bug-fix]",
      finalSummaryPath: join(
        stateDir,
        "loop-runs",
        "hub",
        "1784196600000-hub-bug-fix",
        "supervisor-final-summary.json",
      ),
    } satisfies LoopWorkOrder;
    writeUnfinishedRun(stateDir, order);

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("PR commands should not run without supervisor commits");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(
      new DailyTaskLedger()
        .listForWindow(singaporeDayWindow("2026-07-16"))
        .map((record) => [record.taskId, record.status, record.source]),
    ).toEqual([
      [`loop:hub:bug-fix:${Date.parse("2026-07-16T10:10:00Z")}`, "success", "loop-engineering"],
    ]);
  });

  it("reconciles harness-auto work orders with the harness-auto scheduler key", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(
      projectDir,
      [
        "    harnessAuto:",
        "      enabled: true",
        '      schedule: "*/5 * * * *"',
        "      maxRounds: 2",
        "      strategy: health-first",
        "      stopWhen:",
        "        healthScoreAtLeast: 95",
        "        noConfirmedIssues: true",
      ].join("\n"),
    );
    const order = {
      ...workOrder(stateDir, projectDir),
      id: "1784196600000-hub-harness-auto",
      task: {
        kind: "harness-auto",
        maxRounds: 2,
        strategy: "health-first",
        stopWhen: { healthScoreAtLeast: 95, noConfirmedIssues: true },
        tasks: [],
      },
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1784196600000-hub-harness-auto]",
      finalSummaryPath: join(
        stateDir,
        "loop-runs",
        "hub",
        "1784196600000-hub-harness-auto",
        "supervisor-final-summary.json",
      ),
    } satisfies LoopWorkOrder;
    writeUnfinishedRun(stateDir, order);

    const result = await reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("PR commands should not run without supervisor commits");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(
      new DailyTaskLedger()
        .listForWindow(singaporeDayWindow("2026-07-16"))
        .map((record) => [record.taskId, record.status, record.source]),
    ).toEqual([
      [
        `loop:hub:harness-auto:${Date.parse("2026-07-16T10:10:00Z")}`,
        "success",
        "loop-engineering",
      ],
    ]);
  });
});
