import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCapacityStore } from "../../src/core/automation/capacity-store.js";
import {
  formatActiveDelegateCancel,
  formatActiveDelegateCompletion,
  formatActiveDelegateQueue,
  formatActiveDelegateStart,
  parseDelegateRequirement,
  reconcileAndResumeActiveDelegatedTasksAfterRestart,
  resumeQueuedActiveDelegatedTasks,
} from "../../src/core/autopilot/delegated-task.js";
import type { HandlerDeps } from "../../src/core/deps.js";
import {
  readLoopSupervisorWorkerLeaseState,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import {
  listUnfinishedLoopSupervisorWorkOrders,
  writeLoopSupervisorWorkOrderState,
} from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { setPathForSession } from "../../src/core/projects/sessionPathMap.js";
import { createResourceGuardianStore } from "../../src/core/resource-guardian/store.js";
import type { AppConfig } from "../../src/shared/types.js";

const startLoopSupervisor = vi.fn();

vi.mock("../../src/core/loop/supervisor-session.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/core/loop/supervisor-session.js")>();
  return {
    ...original,
    startLoopSupervisor: (...args: Parameters<typeof original.startLoopSupervisor>) =>
      startLoopSupervisor(...args),
  };
});

const originalStateDir = process.env.TCB_STATE_DIR;

function config(poolSize: number): AppConfig {
  return {
    projectSessionPrefix: "tmux_proj_",
    startCommands: [],
    claudeStartCommand: "claude",
    hostPower: {
      mode: "off",
      timezone: "Asia/Singapore",
      quietStart: "02:00",
      quietEnd: "09:30",
    },
    loopEngineering: {
      configFile: "",
      supervisor: {
        enabled: true,
        agent: "codex",
        dir: join(process.env.TCB_STATE_DIR ?? tmpdir(), "supervisors"),
        poolSize,
        resetBeforeWorkOrder: "compact",
        worktreeIsolation: "isolated",
      },
    },
  } as unknown as AppConfig;
}

function deps(poolSize: number): HandlerDeps {
  return {
    config: config(poolSize),
    configResolver: {
      detectAgentKind: vi.fn(async () => "codex"),
    },
    queue: {
      enqueue: vi.fn(() => false),
    },
  } as unknown as HandlerDeps;
}

function workOrder(input: {
  id: string;
  projectPath: string;
  supervisorSession?: string;
  finalSummaryPath?: string;
}): LoopWorkOrder {
  return {
    id: input.id,
    projectId: input.id,
    projectName: input.id,
    projectPath: input.projectPath,
    session: `tmux_proj_${input.id}`,
    agent: "codex",
    scheduledAt: 1,
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${input.id}]`,
    task: { kind: "active-delegated-task" },
    finalSummaryPath: input.finalSummaryPath,
  } as unknown as LoopWorkOrder;
}

function writeResourceCircuit(
  input: {
    pressure?: "critical" | "emergency";
    admission?: "background-closed";
    reason?: string;
  } = {},
): void {
  const now = Date.now();
  const pressure = input.pressure ?? "critical";
  const admission = input.admission ?? "background-closed";
  const reason = input.reason ?? "critical host pressure";
  const stateDir = process.env.TCB_STATE_DIR;
  if (stateDir === undefined) throw new Error("TCB_STATE_DIR is required for this test");
  createResourceGuardianStore({ stateDir, now: () => now }).writeCurrent({
    circuit: {
      schemaVersion: 1,
      pressure,
      incidentId: "resource-incident-1",
      admission,
      reason,
      changedAt: now,
      lastSampleAt: now,
      owner: "resource-guardian",
    },
    view: {
      enabled: true,
      mode: "protect",
      profile: "balanced",
      pressure,
      circuit: admission,
      incidentId: "resource-incident-1",
      reason,
      attribution: "unknown",
      latestSample: null,
      stableSince: null,
      sampling: {
        degraded: false,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastError: null,
        notifiedPhase: null,
        overlapSkippedTicks: 0,
      },
    },
  });
}

describe("active delegated task supervisor pool", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-delegate-pool-"));
    startLoopSupervisor.mockReset();
  });

  it("marks infrastructure blocks as not queueable", () => {
    expect(
      formatActiveDelegateStart({
        status: "blocked",
        reason: "execution worktree isolation failed",
        showQueue: false,
      }),
    ).toBe("Autopilot delegate blocked: execution worktree isolation failed");
  });

  it("parses and formats active delegation command results", () => {
    expect(parseDelegateRequirement("not delegate this")).toBeNull();
    expect(parseDelegateRequirement(" delegate   ")).toContain(
      "Continue the current user-confirmed task",
    );
    expect(parseDelegateRequirement("delegate fix the failing release gate")).toBe(
      "fix the failing release gate",
    );
    expect(
      formatActiveDelegateStart({
        status: "queued",
        runId: "run-1",
        projectId: "api",
        supervisorSession: "tmux_proj_loop-supervisor-1",
        reportDir: "/tmp/report",
      }),
    ).toContain("report: /tmp/report");
    expect(
      formatActiveDelegateStart({
        status: "queued",
        runId: "run-2",
        projectId: "api",
        supervisorSession: "tmux_proj_loop-supervisor-1",
        reportDir: null,
      }),
    ).not.toContain("report:");
    expect(
      formatActiveDelegateCancel({
        status: "not-found",
        reason: "no active delegated work",
      }),
    ).toBe("No active delegated task: no active delegated work");
    expect(
      formatActiveDelegateCancel({
        status: "cancelled",
        runId: "run-1",
        projectId: "api",
        supervisorSession: "tmux_proj_loop-supervisor-1",
      }),
    ).toContain("Autopilot delegate cancellation requested.");
  });

  it("formats active supervisor queue items with singular/plural and cancellable state", () => {
    expect(formatActiveDelegateQueue([])).toBe("No active loop supervisor work.");
    expect(
      formatActiveDelegateQueue([
        {
          runId: "run-1",
          projectId: "api",
          taskKind: "active-delegated-task",
          status: "queued",
          supervisorSession: "tmux_proj_loop-supervisor-1",
          updatedAt: Date.parse("2026-08-09T00:00:00.000Z"),
          runDir: "/tmp/run-1",
          cancellable: true,
        },
      ]),
    ).toContain("Loop supervisor queue: 1 active work item\n");
    expect(
      formatActiveDelegateQueue([
        {
          runId: "run-1",
          projectId: "api",
          taskKind: "active-delegated-task",
          status: "queued",
          supervisorSession: "tmux_proj_loop-supervisor-1",
          updatedAt: Date.parse("2026-08-09T00:00:00.000Z"),
          runDir: "/tmp/run-1",
          cancellable: true,
        },
        {
          runId: "run-2",
          projectId: "worker",
          taskKind: "architecture",
          status: "in-flight",
          supervisorSession: "tmux_proj_loop-supervisor-2",
          updatedAt: Date.parse("2026-08-09T00:01:00.000Z"),
          runDir: "/tmp/run-2",
          cancellable: false,
        },
      ]),
    ).toContain("Loop supervisor queue: 2 active work items");
  });

  it("blocks active delegation when the supervisor is disabled", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const d = deps(1);
    d.config.loopEngineering.supervisor.enabled = false;

    await expect(
      startActiveDelegatedTask(d, {
        session: "tmux_proj_project",
        requirement: "finish the confirmed task",
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "loop supervisor is disabled; set LOOP_SUPERVISOR_ENABLED=true",
      showQueue: false,
    });
  });

  it("reuses a trusted Resource Guardian repair run id without creating another WorkOrder", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-resource-repair-"));
    const runId = "resource-repair-repair-100-1";
    setPathForSession("tmux_proj_project", projectDir);
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: runId,
        projectPath: projectDir,
        supervisorSession: "tmux_proj_loop-supervisor-1",
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "queued",
      now: 1,
    });

    await expect(
      startActiveDelegatedTask(deps(1), {
        session: "tmux_proj_project",
        requirement: "repair only the durable resource failure",
        resourceTrigger: "resource-repair",
        trustedRunId: runId,
      }),
    ).resolves.toMatchObject({
      status: "queued",
      runId,
      supervisorSession: "tmux_proj_loop-supervisor-1",
    });
    expect(startLoopSupervisor).not.toHaveBeenCalled();
  });

  it("accepts a trusted run id only for resource-repair triggers", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-resource-repair-trigger-"));
    setPathForSession("tmux_proj_project", projectDir);

    await expect(
      startActiveDelegatedTask(deps(1), {
        session: "tmux_proj_project",
        requirement: "repair only the durable resource failure",
        trustedRunId: "resource-repair-repair-100-1",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "invalid trusted resource repair run id",
    });
  });

  it("reuses a terminal trusted repair WorkOrder instead of launching a duplicate", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-terminal-resource-repair-"));
    const runId = "resource-repair-repair-100-1";
    setPathForSession("tmux_proj_project", projectDir);
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: runId,
        projectPath: projectDir,
        supervisorSession: "tmux_proj_loop-supervisor-1",
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "completed",
      now: 1,
    });

    await expect(
      startActiveDelegatedTask(deps(1), {
        session: "tmux_proj_project",
        requirement: "repair only the durable resource failure",
        resourceTrigger: "resource-repair",
        trustedRunId: runId,
      }),
    ).resolves.toMatchObject({ status: "queued", runId });
    expect(startLoopSupervisor).not.toHaveBeenCalled();
  });

  it("defers closed background delegation before session lookup or durable side effects", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    writeResourceCircuit();

    await expect(
      startActiveDelegatedTask(deps(1), {
        session: "tmux_proj_unmapped",
        requirement: "repair the failed task",
        resourceTrigger: "background",
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "automation admission deferred: critical host pressure",
      showQueue: false,
    });

    expect(startLoopSupervisor).not.toHaveBeenCalled();
    expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
    expect(readLoopSupervisorWorkerLeaseState()).toEqual({ leases: [] });
    expect(existsSync(join(process.env.TCB_STATE_DIR ?? "", "loop-runs"))).toBe(false);
    expect(existsSync(join(process.env.TCB_STATE_DIR ?? "", "scheduled_task_ledger.json"))).toBe(
      false,
    );
  });

  it("waits when official agent capacity is exhausted, including operator delegation", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const now = Date.parse("2026-08-13T10:00:00Z");
    new AgentCapacityStore().recordObservation({
      agent: "codex",
      authentication: "subscription",
      state: "exhausted",
      fiveHourPct: 100,
      weeklyPct: 50,
      resetAt: now + 60_000,
      observedAt: now,
      nextProbeAt: now + 60_000,
      latestReason: "official-limit-signal",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(
        startActiveDelegatedTask(deps(1), {
          session: "tmux_proj_unmapped",
          requirement: "finish the confirmed task",
        }),
      ).resolves.toEqual({
        status: "blocked",
        reason: "automation admission deferred: capacity-exhausted",
        showQueue: false,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("defers quiet-hours background delegation before durable side effects", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const d = deps(1);
    d.config.hostPower = {
      mode: "scheduled",
      timezone: "Asia/Singapore",
      quietStart: "02:00",
      quietEnd: "09:30",
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-16T20:10:00Z"));
    try {
      await expect(
        startActiveDelegatedTask(d, {
          session: "tmux_proj_unmapped",
          requirement: "repair the failed task",
          resourceTrigger: "background",
        }),
      ).resolves.toEqual({
        status: "blocked",
        reason: "automation admission deferred: quiet-hours",
        showQueue: false,
      });
    } finally {
      now.mockRestore();
    }

    expect(startLoopSupervisor).not.toHaveBeenCalled();
    expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
    expect(readLoopSupervisorWorkerLeaseState()).toEqual({ leases: [] });
    expect(existsSync(join(process.env.TCB_STATE_DIR ?? "", "loop-runs"))).toBe(false);
    expect(existsSync(join(process.env.TCB_STATE_DIR ?? "", "scheduled_task_ledger.json"))).toBe(
      false,
    );
  });

  it("defaults resource admission to operator and permits nonemergency forced delegation", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    writeResourceCircuit();

    await expect(
      startActiveDelegatedTask(deps(1), {
        session: "tmux_proj_unmapped",
        requirement: "repair the failed task",
        resourceForce: true,
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: 'no project path is recorded for session "tmux_proj_unmapped"',
      showQueue: false,
    });
  });

  it("does not let force override emergency resource admission", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    writeResourceCircuit({ pressure: "emergency", reason: "emergency host pressure" });

    await expect(
      startActiveDelegatedTask(deps(1), {
        session: "tmux_proj_unmapped",
        requirement: "repair the failed task",
        resourceForce: true,
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "automation admission deferred: emergency host pressure",
      showQueue: false,
    });
  });

  it("blocks active delegation when the session has no recorded project path", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");

    await expect(
      startActiveDelegatedTask(deps(1), {
        session: "tmux_proj_missing",
        requirement: "finish the confirmed task",
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: 'no project path is recorded for session "tmux_proj_missing"',
      showQueue: false,
    });
  });

  it("blocks active delegation when no loop supervisor sessions are configured", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-no-supervisors-"));
    setPathForSession("tmux_proj_project", projectDir);

    await expect(
      startActiveDelegatedTask(deps(0), {
        session: "tmux_proj_project",
        requirement: "finish the confirmed task",
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "failed to ensure queued loop supervisor session tmux_proj_loop-supervisor",
      showQueue: true,
    });
  });

  it("distinguishes completed work from a failed system acceptance gate", () => {
    expect(
      formatActiveDelegateCompletion({
        resultStatus: "supervisor-failed",
        gateFailures: ["source worktree is dirty after supervisor completion"],
      }),
    ).toEqual({
      level: "warning",
      title: "Delegated task completed; system acceptance failed",
      summary:
        "Supervisor completed the delegated task, but the system acceptance gate failed: source worktree is dirty after supervisor completion.",
    });
  });

  it("keeps genuine supervisor failures distinct from acceptance failures", () => {
    expect(
      formatActiveDelegateCompletion({
        resultStatus: "supervisor-failed",
        gateFailures: [],
      }),
    ).toEqual({
      level: "error",
      title: "Delegated task supervisor-failed",
      summary: "Active delegated task did not complete successfully.",
    });
  });

  it("resumes queued active delegations after a process restart", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    const order = workOrder({ id: "queued-after-restart", projectPath: projectDir });
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "queued",
      now: Date.now(),
    });
    const d = deps(1);
    d.bridge = { hasSession: vi.fn(async () => true) } as unknown as HandlerDeps["bridge"];
    d.queue = {
      cancelQueued: vi.fn(),
      enqueue: vi.fn(() => false),
    } as unknown as HandlerDeps["queue"];

    expect(resumeQueuedActiveDelegatedTasks(d)).toBe(1);
  });

  it("reconciles restart liveness against the leased supervisor session", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-live-supervisor-"));
    const order = {
      ...workOrder({ id: "live-supervisor-after-restart", projectPath: projectDir }),
      workerSession: "tmux_proj_loop-worker-derived-name",
    };
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor-1",
          workOrderId: order.id,
          projectId: order.projectId,
          projectPath: projectDir,
          status: "active",
          leasedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const d = deps(1);
    d.bridge = {
      hasSession: vi.fn(async (session: string) => session === "tmux_proj_loop-supervisor-1"),
      capturePane: vi.fn(async () => "• Working (2s • esc to interrupt)"),
    } as unknown as HandlerDeps["bridge"];
    d.configResolver = {
      isCodexRunning: vi.fn(async () => true),
    } as unknown as HandlerDeps["configResolver"];

    vi.useFakeTimers();
    const reconciliation = reconcileAndResumeActiveDelegatedTasksAfterRestart(d);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await reconciliation).toBe(0);
    vi.useRealTimers();
    expect(
      listUnfinishedLoopSupervisorWorkOrders().some((record) => record.workOrder.id === order.id),
    ).toBe(true);
    expect(readLoopSupervisorWorkerLeaseState().leases[0]?.status).toBe("active");
  });

  it("releases an in-flight lease when only an idle supervisor process survived restart", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-idle-supervisor-"));
    const order = workOrder({ id: "idle-supervisor-after-restart", projectPath: projectDir });
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor-1",
          workOrderId: order.id,
          projectId: order.projectId,
          projectPath: projectDir,
          status: "active",
          leasedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const d = deps(1);
    d.bridge = {
      hasSession: vi.fn(async () => true),
      capturePane: vi.fn(async () => "› Ready for the next prompt"),
    } as unknown as HandlerDeps["bridge"];
    d.configResolver = {
      isCodexRunning: vi.fn(async () => true),
    } as unknown as HandlerDeps["configResolver"];

    vi.useFakeTimers();
    const reconciliation = reconcileAndResumeActiveDelegatedTasksAfterRestart(d);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await reconciliation).toBe(0);
    vi.useRealTimers();
    expect(
      listUnfinishedLoopSupervisorWorkOrders().some((record) => record.workOrder.id === order.id),
    ).toBe(false);
    expect(readLoopSupervisorWorkerLeaseState().leases[0]?.status).toBe("retained");
  });

  it("reconciles an active lease whose worker disappeared during restart", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-orphan-"));
    const order = workOrder({ id: "orphaned-after-restart", projectPath: projectDir });
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-worker-orphaned",
          workOrderId: order.id,
          projectId: order.projectId,
          projectPath: projectDir,
          status: "active",
          leasedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const d = deps(1);
    d.bridge = { hasSession: vi.fn(async () => false) } as unknown as HandlerDeps["bridge"];

    vi.useFakeTimers();
    const reconciliation = reconcileAndResumeActiveDelegatedTasksAfterRestart(d);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await reconciliation).toBe(0);
    vi.useRealTimers();
    expect(
      listUnfinishedLoopSupervisorWorkOrders().some((record) => record.workOrder.id === order.id),
    ).toBe(false);
    expect(readLoopSupervisorWorkerLeaseState().leases[0]?.status).toBe("retained");
  });

  it("does not classify a worker as orphaned during agent startup", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-startup-"));
    const order = workOrder({ id: "starting-after-restart", projectPath: projectDir });
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-worker-starting",
          workOrderId: order.id,
          projectId: order.projectId,
          projectPath: projectDir,
          status: "active",
          leasedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const d = deps(1);
    d.bridge = {
      hasSession: vi.fn(async () => true),
      capturePane: vi.fn(async () => "• Working (2s • esc to interrupt)"),
    } as unknown as HandlerDeps["bridge"];
    d.configResolver = {
      isCodexRunning: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    } as unknown as HandlerDeps["configResolver"];

    expect(await reconcileAndResumeActiveDelegatedTasksAfterRestart(d)).toBe(0);
    expect(
      listUnfinishedLoopSupervisorWorkOrders().some((record) => record.workOrder.id === order.id),
    ).toBe(true);
    expect(readLoopSupervisorWorkerLeaseState().leases[0]?.status).toBe("active");
  });

  it("waits for a worker session that is created late during startup", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-late-session-"));
    const order = workOrder({ id: "late-session-after-restart", projectPath: projectDir });
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-worker-late-session",
          workOrderId: order.id,
          projectId: order.projectId,
          projectPath: projectDir,
          status: "active",
          leasedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const d = deps(1);
    let sessionChecks = 0;
    d.bridge = {
      hasSession: vi.fn(async () => {
        sessionChecks += 1;
        return sessionChecks > 2;
      }),
      capturePane: vi.fn(async () => "• Working (2s • esc to interrupt)"),
    } as unknown as HandlerDeps["bridge"];
    d.configResolver = {
      isCodexRunning: vi.fn().mockResolvedValue(true),
    } as unknown as HandlerDeps["configResolver"];

    vi.useFakeTimers();
    const reconciliation = reconcileAndResumeActiveDelegatedTasksAfterRestart(d);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await reconciliation).toBe(0);
    vi.useRealTimers();
    expect(
      listUnfinishedLoopSupervisorWorkOrders().some((record) => record.workOrder.id === order.id),
    ).toBe(true);
    expect(readLoopSupervisorWorkerLeaseState().leases[0]?.status).toBe("active");
  });

  afterEach(() => {
    const stateDir = process.env.TCB_STATE_DIR;
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = originalStateDir;
  });

  it("tries the next supervisor when the first candidate cannot be ensured", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    setPathForSession("tmux_proj_project", projectDir);
    startLoopSupervisor.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-2",
    });
    expect(startLoopSupervisor.mock.calls.map((call) => call[2])).toEqual([
      "tmux_proj_loop-supervisor-1",
      "tmux_proj_loop-supervisor-2",
    ]);
  });

  it("does not treat retained worker leases as active supervisor work", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    setPathForSession("tmux_proj_project", projectDir);
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor-1",
          workOrderId: "previous-failed-run",
          projectId: "geo-backend",
          projectPath: "/repo/geo-backend",
          status: "retained",
          leasedAt: 1000,
          updatedAt: 2000,
          retainUntil: Date.now() + 60_000,
        },
      ],
    });
    startLoopSupervisor.mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-1",
    });
    expect(startLoopSupervisor.mock.calls.map((call) => call[2])).toEqual([
      "tmux_proj_loop-supervisor-1",
    ]);
  });

  it("reserves supervisor workers before dispatch so concurrent delegation uses separate sessions", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const firstProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-first-"));
    const secondProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-second-"));
    setPathForSession("tmux_proj_first", firstProjectDir);
    setPathForSession("tmux_proj_second", secondProjectDir);
    startLoopSupervisor.mockResolvedValue(true);
    const d = deps(2);
    d.bridge = { hasSession: vi.fn(async () => true) } as unknown as HandlerDeps["bridge"];
    d.queue = {
      cancelQueued: vi.fn(),
      enqueue: vi.fn(() => "queued"),
    } as unknown as HandlerDeps["queue"];

    const [first, second] = await Promise.all([
      startActiveDelegatedTask(d, {
        session: "tmux_proj_first",
        requirement: "read-only review gate smoke",
      }),
      startActiveDelegatedTask(d, {
        session: "tmux_proj_second",
        requirement: "read-only review gate smoke",
      }),
    ]);

    expect(first).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-1",
    });
    expect(second).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-2",
    });
    expect(
      readLoopSupervisorWorkerLeaseState()
        .leases.filter((lease) => lease.status === "active")
        .map((lease) => lease.workerSession)
        .sort(),
    ).toEqual(["tmux_proj_loop-supervisor-1", "tmux_proj_loop-supervisor-2"]);
  });

  it("blocks a concurrent delegation for the same project during startup", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-shared-"));
    setPathForSession("tmux_proj_shared_a", projectDir);
    setPathForSession("tmux_proj_shared_b", projectDir);
    startLoopSupervisor.mockResolvedValue(true);
    const d = deps(2);
    d.bridge = { hasSession: vi.fn(async () => true) } as unknown as HandlerDeps["bridge"];
    d.queue = {
      cancelQueued: vi.fn(),
      enqueue: vi.fn(() => "queued"),
    } as unknown as HandlerDeps["queue"];

    const [first, second] = await Promise.all([
      startActiveDelegatedTask(d, {
        session: "tmux_proj_shared_a",
        requirement: "repair the shared project",
      }),
      startActiveDelegatedTask(d, {
        session: "tmux_proj_shared_b",
        requirement: "repair the shared project again",
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["blocked", "queued"]);
    expect([first, second].find((result) => result.status === "blocked")).toMatchObject({
      reason: expect.stringContaining("being started"),
      showQueue: true,
    });
  });

  it("writes gate evidence and releases the supervisor lease after active delegation succeeds", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    setPathForSession("tmux_proj_project", projectDir);
    startLoopSupervisor.mockResolvedValueOnce(true);
    const notify = vi.fn(async () => ({ status: "sent", deliveries: [] }));
    const d = deps(1);
    d.bridge = { hasSession: vi.fn(async () => true) } as unknown as HandlerDeps["bridge"];
    d.notifications = { notify } as unknown as HandlerDeps["notifications"];
    d.queue = {
      cancelQueued: vi.fn(),
      enqueue: vi.fn((message: any) => {
        if (message.action !== "text") {
          message.resolve("compacted");
          return "queued";
        }
        const marker = message.text.match(/\[LOOP_SUPERVISOR_DONE:([^\]]+)\]/)?.[1];
        if (marker === undefined) throw new Error("missing final marker in prompt");
        message.started?.();
        queueMicrotask(() =>
          message.resolve(
            [
              `[LOOP_SUPERVISOR_DONE:${marker}]`,
              JSON.stringify({
                status: "completed",
                projectId: "project",
                actionsTaken: ["checked and completed"],
                delegatedTasks: [],
                finalVerification: "passed",
                reviewGate: {
                  preMutationReview: ["reviewed bounded requirement before work"],
                  postMutationReview: ["verified no unintended changes"],
                  aiReview: "not-applicable",
                  deterministicGates: [
                    {
                      name: "no mutating git or PR gate required",
                      result: "skipped",
                    },
                  ],
                  decision: "pass",
                  notes: [],
                },
                planReview: {
                  checklistCompleted: true,
                  targetScoreMet: "not-applicable",
                  stopConditionReached: false,
                  overOptimizationAvoided: true,
                  verificationCompleted: true,
                  remainingRisks: [],
                },
                commits: [],
                followUps: [],
              }),
            ].join("\n"),
          ),
        );
        return "queued";
      }),
    } as unknown as HandlerDeps["queue"];

    const result = await startActiveDelegatedTask(d, {
      session: "tmux_proj_project",
      requirement: "finish the confirmed task",
      resourceTrigger: "background",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor",
    });
    if (result.status !== "queued" || result.reportDir === null) throw new Error("expected queued");
    await waitForFile(join(result.reportDir, "system-gate.json"));

    expect(JSON.parse(readFileSync(join(result.reportDir, "system-gate.json"), "utf8"))).toEqual(
      expect.objectContaining({
        workOrderId: result.runId,
        projectId: result.projectId,
        resultStatus: "completed",
        accepted: true,
        evidence: expect.arrayContaining(["no mutating git or PR gate required"]),
        failures: [],
      }),
    );
    expect(
      JSON.parse(
        readFileSync(join(process.env.TCB_STATE_DIR ?? "", "scheduled_task_ledger.json"), "utf8"),
      ),
    ).toEqual(
      expect.objectContaining({
        [`autopilot:${result.runId}`]: expect.objectContaining({
          taskId: `autopilot:${result.runId}`,
          source: "autopilot-delegate",
          status: "success",
          repairStatus: "not-needed",
        }),
      }),
    );
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("recovers active delegation when a valid final summary file lands after output capture settles", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    setPathForSession("tmux_proj_project", projectDir);
    startLoopSupervisor.mockResolvedValueOnce(true);
    const notify = vi.fn(async () => ({ status: "sent", deliveries: [] }));
    const d = deps(1);
    d.bridge = { hasSession: vi.fn(async () => true) } as unknown as HandlerDeps["bridge"];
    d.notifications = { notify } as unknown as HandlerDeps["notifications"];
    d.queue = {
      cancelQueued: vi.fn(),
      enqueue: vi.fn((message: any) => {
        if (message.action !== "text") {
          message.resolve("compacted");
          return "queued";
        }
        const summaryPathMatch = message.text.match(
          /Write the strict JSON final summary to '([^']+)'/,
        );
        if (summaryPathMatch?.[1] === undefined) throw new Error("missing summary path");
        message.started?.();
        queueMicrotask(() => {
          message.resolve("supervisor output ended before final marker was captured");
          setTimeout(() => {
            mkdirSync(dirname(summaryPathMatch[1]), { recursive: true });
            writeFileSync(
              summaryPathMatch[1],
              `${JSON.stringify({
                status: "completed",
                projectId: "project",
                actionsTaken: ["late final summary recovered"],
                delegatedTasks: [],
                finalVerification: "passed",
                reviewGate: {
                  preMutationReview: ["bounded no-op task"],
                  postMutationReview: ["no diff"],
                  aiReview: "not-applicable",
                  deterministicGates: [],
                  decision: "pass",
                  notes: [],
                },
                planReview: {
                  checklistCompleted: true,
                  targetScoreMet: "not-applicable",
                  stopConditionReached: false,
                  overOptimizationAvoided: true,
                  verificationCompleted: true,
                  remainingRisks: [],
                },
                commits: [],
                followUps: [],
              })}\n`,
            );
          }, 1200);
        });
        return "queued";
      }),
    } as unknown as HandlerDeps["queue"];

    const result = await startActiveDelegatedTask(d, {
      session: "tmux_proj_project",
      requirement: "finish the confirmed task",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor",
    });
    if (result.status !== "queued" || result.reportDir === null) throw new Error("expected queued");
    await waitForFile(join(result.reportDir, "system-gate.json"), 3000);

    expect(JSON.parse(readFileSync(join(result.reportDir, "system-gate.json"), "utf8"))).toEqual(
      expect.objectContaining({
        workOrderId: result.runId,
        projectId: result.projectId,
        resultStatus: "completed",
        accepted: true,
        failures: [],
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        title: "Delegated task completed",
      }),
    );
    expect(
      JSON.parse(readFileSync(join(result.reportDir, "work-order-state.json"), "utf8")),
    ).toEqual(
      expect.objectContaining({
        status: "completed",
        resultStatus: "completed",
      }),
    );
  });

  it("keeps recoverable failed supervisor work orders reserved during allocation", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    setPathForSession("tmux_proj_project", projectDir);
    const summaryDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "recoverable",
      "recoverable",
    );
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: "recoverable",
        projectPath: staleProjectDir,
        finalSummaryPath,
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "invalid-output",
      now: 2,
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      finalSummaryPath,
      `${JSON.stringify({
        status: "completed",
        projectId: "recoverable",
        actionsTaken: ["late summary arrived"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      })}\n`,
    );
    startLoopSupervisor.mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-2",
    });
    expect(startLoopSupervisor.mock.calls.map((call) => call[2])).toEqual([
      "tmux_proj_loop-supervisor-2",
    ]);
  });

  it("does not reserve failed supervisor work orders that have no final summary to recover", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    setPathForSession("tmux_proj_project", projectDir);
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({ id: "unrecoverable", projectPath: staleProjectDir }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "dispatch-failed",
      now: 2,
    });
    startLoopSupervisor.mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-1",
    });
    expect(startLoopSupervisor.mock.calls.map((call) => call[2])).toEqual([
      "tmux_proj_loop-supervisor-1",
    ]);
  });

  it("does not reserve failed supervisor work orders with invalid final summaries", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    setPathForSession("tmux_proj_project", projectDir);
    const summaryDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "invalid-recoverable",
      "invalid-recoverable",
    );
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: "invalid-recoverable",
        projectPath: staleProjectDir,
        finalSummaryPath,
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "invalid-output",
      now: 2,
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(finalSummaryPath, '{"status":"completed"}\n');
    startLoopSupervisor.mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-1",
    });
  });

  it("does not keep stale unfinished work orders reserved without a final summary", () => {
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({ id: "stale-dispatching", projectPath: staleProjectDir }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "dispatching",
      now: Date.now() - 13 * 60 * 60 * 1000,
    });

    expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
  });

  it("does not keep unfinished work orders reserved after a valid final summary arrives", () => {
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-finished-summary-"));
    const summaryDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "finished-summary",
      "finished-summary",
    );
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: "finished-summary",
        projectPath: staleProjectDir,
        finalSummaryPath,
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now: Date.now(),
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      finalSummaryPath,
      `${JSON.stringify({
        status: "completed",
        projectId: "finished-summary",
        actionsTaken: ["late summary arrived"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      })}\n`,
    );

    expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
  });

  it("does not keep unfinished work orders reserved after an invalid final summary grace period", () => {
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-invalid-"));
    const summaryDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "stale-invalid-summary",
      "stale-invalid-summary",
    );
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: "stale-invalid-summary",
        projectPath: staleProjectDir,
        finalSummaryPath,
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "dispatching",
      now: Date.now() - 10 * 60 * 1000,
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(finalSummaryPath, '{"status":"completed"}\n');

    expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
  });
});

async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}
