import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import {
  reconcileProjectRecoveryArtifacts,
  runProjectRecoveryPass,
} from "../../src/core/tasks/project-recovery-service.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("project recovery service", () => {
  it("uses WorkOrder evidence to recover active-delegate records for repository targets", async () => {
    const stateDir = join(tmpdir(), `project-recovery-work-order-${Date.now()}`);
    process.env.TCB_STATE_DIR = stateDir;
    const reportPath = join(stateDir, "loop-runs", "net-auto-switch", "run-1");
    await mkdir(reportPath, { recursive: true });
    await writeFile(
      join(reportPath, "work-order.json"),
      JSON.stringify({
        id: "run-1",
        projectId: "net-auto-switch",
        task: {
          kind: "active-delegated-task",
          requirement:
            "Historical scheduled task recovery for a configured project.\nProject: net-auto-switch-all-prs\nRepository: /repo/net-auto-switch\n",
        },
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const dispatch = vi.fn(async () => ({ status: "queued" as const, runId: "run-2" }));
    const updateRepairStatus = vi.fn();

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:run-1",
          source: "autopilot-delegate",
          name: "net-auto-switch active delegated task",
          status: "failed",
          error: "blocked",
          failureKind: "invalid-final-summary",
          summary:
            "Recovery classification: needs-owner-decision; configured project is unavailable or ambiguous.",
          reportPath,
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "blocked",
        },
      ],
      config: {
        projects: [],
        repositories: [{ id: "net-auto-switch-all-prs", path: "/repo/net-auto-switch" }],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ unconfigured: 0, dispatched: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          kind: "repository",
          id: "net-auto-switch-all-prs",
        }),
      }),
    );
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:run-1",
      "running",
      "Project recovery delegated run run-2.",
    );
  });

  it("uses sidecar WorkOrder evidence when reportPath points at supervisor markdown", async () => {
    const stateDir = join(tmpdir(), `project-recovery-markdown-report-${Date.now()}`);
    process.env.TCB_STATE_DIR = stateDir;
    const reportDir = join(stateDir, "loop-runs", "net-auto-switch", "run-md");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, "supervisor.md");
    await writeFile(reportPath, "Supervisor failed before final summary.\n".repeat(2_000));
    await writeFile(
      join(reportDir, "work-order.json"),
      JSON.stringify({
        id: "run-md",
        task: {
          kind: "active-delegated-task",
          requirement:
            "Historical scheduled task recovery for a configured project.\nProject: net-auto-switch-all-prs\nRepository: /repo/net-auto-switch\n",
        },
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const dispatch = vi.fn(async () => ({ status: "queued" as const, runId: "run-next" }));

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:net-auto-switch:active-delegated-task:run-md",
          source: "loop-engineering",
          name: "net-auto-switch active-delegated-task",
          status: "failed",
          error: "blocked",
          failureKind: "invalid-final-summary",
          summary:
            "Recovery classification: needs-owner-decision; configured project is unavailable or ambiguous. supervisor completion evidence is invalid or incomplete and can be retried",
          reportPath,
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "blocked",
        },
      ],
      config: {
        projects: [],
        repositories: [{ id: "net-auto-switch-all-prs", path: "/repo/net-auto-switch" }],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus: vi.fn(),
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ unconfigured: 0, dispatched: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ id: "net-auto-switch-all-prs" }),
      }),
    );
  });

  it("defers a second recovery instead of creating a same-project duplicate", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const active = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "old-failure",
      taskId: "loop:geo:bug-fix:1",
      now: 1_000,
    });
    coordinator.claimIds([active.id], { now: 1_001, leaseId: "active", limit: 1 });
    const updateRepairStatus = vi.fn();

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:2",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: 1_500,
          updatedAt: 1_900,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch: vi.fn(),
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ enqueued: 0, deferred: 1, dispatched: 0 });
    expect(coordinator.list()).toHaveLength(1);
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:2",
      "pending",
      expect.stringContaining("active recovery"),
    );
  });

  it("counts immediate dispatch blocks as deferred recovery work", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:quiet",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch: vi.fn(async () => ({
        status: "blocked" as const,
        detail: "automation admission deferred: quiet-hours",
      })),
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ enqueued: 1, deferred: 1, dispatched: 0 });
    expect(coordinator.list()).toEqual([
      expect.objectContaining({ source: "project-recovery", status: "pending", attempt: 0 }),
    ]);
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:quiet",
      "pending",
      "Recovery dispatch deferred: automation admission deferred: quiet-hours",
    );
  });

  it("does not claim or consume retries while a live project WorkOrder owns the project", async () => {
    process.env.TCB_STATE_DIR = join(tmpdir(), `project-recovery-live-${Date.now()}`);
    const now = Date.now();
    writeLoopSupervisorWorkOrderState({
      workOrder: {
        id: "live-recovery",
        projectId: "geo",
        projectName: "Geo",
        projectPath: "/repo/geo",
        scheduledAt: now,
        requiredFinalMarker: "[done]",
        task: { kind: "active-delegated-task" },
      } as never,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now,
    });
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "worker-handoff",
      taskId: "loop:geo:bug-fix:live",
      now,
    });
    const dispatch = vi.fn();
    const updateRepairStatus = vi.fn();

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:live",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: now,
          updatedAt: now,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ deferred: 1, dispatched: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:live",
      "pending",
      expect.stringContaining("active WorkOrder"),
    );
  });

  it("does not dispatch while a nonterminal WorkOrder final summary awaits settlement", async () => {
    process.env.TCB_STATE_DIR = join(tmpdir(), `project-recovery-settling-${Date.now()}`);
    const now = Date.now();
    const runId = "settling-recovery";
    const runDir = join(process.env.TCB_STATE_DIR, "loop-runs", "geo", runId);
    writeLoopSupervisorWorkOrderState({
      workOrder: {
        id: runId,
        projectId: "geo",
        projectName: "Geo",
        projectPath: "/repo/geo",
        scheduledAt: now,
        requiredFinalMarker: "[done]",
        finalSummaryPath: join(runDir, "supervisor-final-summary.json"),
        task: { kind: "active-delegated-task" },
      } as never,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "in-flight",
      now,
    });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "geo",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "worker-handoff",
      taskId: "loop:geo:bug-fix:settling",
      now,
    });
    const dispatch = vi.fn();
    const updateRepairStatus = vi.fn();

    const result = await runProjectRecoveryPass({
      now: now + 1,
      records: [
        {
          taskId: "loop:geo:bug-fix:settling",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: now,
          updatedAt: now,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ deferred: 1, dispatched: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:settling",
      "pending",
      expect.stringContaining("active WorkOrder"),
    );
  });

  it("does not dispatch while a failed WorkOrder final summary awaits settlement", async () => {
    process.env.TCB_STATE_DIR = join(tmpdir(), `project-recovery-recoverable-failed-${Date.now()}`);
    const now = Date.now();
    const runId = "recoverable-failed-recovery";
    const runDir = join(process.env.TCB_STATE_DIR, "loop-runs", "geo", runId);
    const finalSummaryPath = join(runDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: {
        id: runId,
        projectId: "geo",
        projectName: "Geo",
        projectPath: "/repo/geo",
        scheduledAt: now,
        requiredFinalMarker: "[done]",
        finalSummaryPath,
        task: { kind: "active-delegated-task" },
      } as never,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "invalid-output",
      now,
    });
    await writeFile(
      finalSummaryPath,
      JSON.stringify({
        status: "completed",
        projectId: "geo",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "worker-handoff",
      taskId: "loop:geo:bug-fix:recoverable-failed",
      now,
    });
    const dispatch = vi.fn();
    const updateRepairStatus = vi.fn();

    const result = await runProjectRecoveryPass({
      now: now + 1,
      records: [
        {
          taskId: "loop:geo:bug-fix:recoverable-failed",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: now,
          updatedAt: now,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ deferred: 1, dispatched: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:recoverable-failed",
      "pending",
      expect.stringContaining("active WorkOrder"),
    );
  });

  it("releases a recovery lease when every linked WorkOrder is already terminal", async () => {
    process.env.TCB_STATE_DIR = join(tmpdir(), `project-recovery-terminal-${Date.now()}`);
    writeLoopSupervisorWorkOrderState({
      workOrder: {
        id: "terminal-recovery",
        projectId: "geo",
        projectName: "Geo",
        projectPath: "/repo/geo",
        scheduledAt: 1_000,
        requiredFinalMarker: "[done]",
        task: { kind: "active-delegated-task" },
      } as never,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "invalid-output",
      now: 1_500,
    });
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const active = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "old-failure",
      taskId: "autopilot:terminal-recovery",
      now: 1_000,
    });
    coordinator.claimIds([active.id], { now: 1_001, leaseId: "active", limit: 1 });

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:2",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: 1_500,
          updatedAt: 1_900,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus: vi.fn(),
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ deferred: 0, dispatched: 0 });
    expect(coordinator.list()[0]).toMatchObject({ status: "pending" });
  });

  it("closes a delegated recovery from an authoritative successful final summary", async () => {
    const root = join(tmpdir(), `project-recovery-${Date.now()}`);
    const runDir = join(root, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "geo",
        actionsTaken: ["restored worker environment"],
        delegatedTasks: [],
        finalVerification: "passed",
        reviewGate: { decision: "pass" },
        commits: [],
        followUps: [],
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "worker-not-consumed",
      taskId: "loop:geo:bug-fix:3",
      now: 1_000,
    });
    coordinator.claimIds([queue.id], { now: 1_001, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queue.id, "recovery", 1_001);
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:3",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "Project recovery delegated run recovery.",
          reportPath: join(runDir, "supervisor-final-summary.json"),
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:3",
      "fixed",
      expect.stringContaining("authoritative supervisor final summary"),
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "fixed",
    });
  });

  it("closes a failed Autopilot record from its passing authoritative final summary", async () => {
    const runDir = join(tmpdir(), `project-recovery-autopilot-summary-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "bot",
        actionsTaken: ["verified existing repair"],
        delegatedTasks: [],
        finalVerification: "passed",
        reviewGate: { decision: "pass" },
        commits: [],
        followUps: [],
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "bot",
      projectPath: "/repo/bot",
      source: "project-recovery",
      taskFamily: "active delegated task",
      fingerprint: "missing-system-gate",
      taskId: "autopilot:completed-before-restart",
      now: 1_000,
    });
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:completed-before-restart",
          source: "autopilot-delegate",
          name: "bot active delegated task",
          status: "failed",
          error: "missing system gate during the earlier reconciliation pass",
          reportPath: runDir,
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:completed-before-restart",
      "fixed",
      expect.stringContaining("authoritative supervisor final summary"),
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "fixed",
    });
  });

  it("closes pending project recovery when linked original tasks are already fixed", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo-backend",
      projectPath: "/repo/geo-backend",
      source: "project-recovery",
      taskFamily: "geo-backend security-maintenance",
      fingerprint: "security assessment exit 1",
      taskId: "loop:geo-backend:security-maintenance:1",
      now: 1_000,
    });
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo-backend:security-maintenance:1",
          source: "loop-engineering",
          name: "geo-backend security-maintenance",
          status: "skipped",
          repairStatus: "fixed",
          summary: "Assessment rerun succeeded with riskScore=0.",
          scheduledAt: 1_000,
          updatedAt: 1_500,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).not.toHaveBeenCalled();
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "fixed",
    });
  });

  it("supersedes failed delegated recoveries when the original task is already fixed", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "loop-engineering",
      taskFamily: "tmux-claude-bot bug-fix",
      fingerprint: "unknown",
      taskId: "loop:tmux-claude-bot:bug-fix:1",
      now: 1_000,
    });
    coordinator.linkTaskIds(queue.id, ["autopilot:recovery-cancelled"], 1_001);
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:tmux-claude-bot:bug-fix:1",
          source: "loop-engineering",
          name: "tmux-claude-bot bug-fix",
          status: "failed",
          repairStatus: "fixed",
          summary:
            "Closed from the authoritative supervisor final summary; recovery completed and verification passed.",
          scheduledAt: 1_000,
          updatedAt: 1_500,
        },
        {
          taskId: "autopilot:recovery-cancelled",
          source: "autopilot-delegate",
          name: "tmux-claude-bot active delegated task",
          status: "failed",
          repairStatus: "pending",
          error: "active delegation ended with cancelled",
          summary: "Delegated recovery failed; returned to the repair queue for another worker.",
          scheduledAt: 1_100,
          updatedAt: 1_600,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:recovery-cancelled",
      "superseded",
      "Superseded by an authoritative terminal repair outcome for the original task.",
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "fixed",
    });
  });

  it("keeps accepted blocked project recovery terminal after later deferral summaries", async () => {
    const store = new InMemoryRepairQueueStore();
    const coordinator = new RepairCoordinator(store);
    const queue = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine active-delegated-task",
      fingerprint: "score-null",
      taskId: "autopilot:original",
      now: 1_000,
    });
    store.set(queue.id, {
      ...queue,
      summaries: [
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
        "Recovery dispatch deferred: automation admission deferred: capacity-exhausted",
      ],
      updatedAt: 1_200,
    });
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:original",
          source: "autopilot-delegate",
          name: "knowledge-engine active delegated task",
          status: "failed",
          repairStatus: "pending",
          scheduledAt: 1_000,
          updatedAt: 1_500,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 0, fixed: 0, blocked: 1 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:original",
      "blocked",
      "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "blocked",
    });
  });

  it("closes loop active-delegate ledger twins for terminal accepted blocked recoveries", async () => {
    const runDir = join(tmpdir(), `project-recovery-terminal-twin-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "blocked",
        finalVerification: "passed",
        reviewGate: { decision: "block" },
      }),
    );
    const store = new InMemoryRepairQueueStore();
    const coordinator = new RepairCoordinator(store);
    const queue = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine active-delegated-task",
      fingerprint: "accepted-blocked",
      taskId: "autopilot:1786971506424-knowledge-engine-active-delegate",
      summary:
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      now: 1_000,
    });
    coordinator.linkTaskIds(
      queue.id,
      ["autopilot:1786972706589-knowledge-engine-active-delegate"],
      1_100,
    );
    coordinator.markTerminal(queue.id, "blocked", 1_200);
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:1786972706589-knowledge-engine-active-delegate",
          source: "autopilot-delegate",
          name: "knowledge-engine active delegated task",
          status: "failed",
          repairStatus: "blocked",
          scheduledAt: 1_100,
          updatedAt: 1_500,
        },
        {
          taskId: "loop:knowledge-engine:active-delegated-task:1786972706589",
          source: "loop-engineering",
          name: "knowledge-engine active-delegated-task",
          status: "failed",
          repairStatus: "pending",
          reportPath: runDir,
          scheduledAt: 1_100,
          updatedAt: 1_500,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 0, fixed: 0, blocked: 1 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:knowledge-engine:active-delegated-task:1786972706589",
      "blocked",
      "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
    );
    expect(updateRepairStatus).not.toHaveBeenCalledWith(
      "loop:knowledge-engine:active-delegated-task:1786972706589",
      "blocked",
      expect.stringContaining("Authoritative supervisor final summary reports blocked recovery"),
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "blocked",
    });
  });

  it("does not requeue loop active-delegate twins already covered by terminal recovery", async () => {
    const store = new InMemoryRepairQueueStore();
    const coordinator = new RepairCoordinator(store);
    const queue = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine active-delegated-task",
      fingerprint: "accepted-blocked",
      taskId: "autopilot:1786971506424-knowledge-engine-active-delegate",
      summary:
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      now: 1_000,
    });
    coordinator.linkTaskIds(
      queue.id,
      ["autopilot:1786972706589-knowledge-engine-active-delegate"],
      1_100,
    );
    coordinator.markTerminal(queue.id, "blocked", 1_200);
    const updateRepairStatus = vi.fn();
    const dispatch = vi.fn();

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:knowledge-engine:active-delegated-task:1786972706589",
          source: "loop-engineering",
          name: "knowledge-engine active-delegated-task",
          status: "failed",
          repairStatus: "pending",
          error: "blocked",
          summary: "Recovery dispatch deferred: automation admission deferred: capacity-exhausted",
          scheduledAt: 1_100,
          updatedAt: 1_500,
        },
      ],
      config: {
        projects: [
          { id: "knowledge-engine", name: "Knowledge Engine", path: "/repo/knowledge-engine" },
        ],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ classified: 0, ownerDecision: 0, dispatched: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:knowledge-engine:active-delegated-task:1786972706589",
      "blocked",
      "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
    );
  });

  it("blocks waiting-external recoveries instead of leaving them pending", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const dispatch = vi.fn();

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:pr-review:fluent-frame-all-prs:1",
          source: "loop-engineering",
          name: "fluent-frame-all-prs repository-pull-request-review",
          status: "failed",
          error: "blocked",
          summary:
            "GitHub Actions job was not started because recent account payments failed or spending limit needs to be increased.",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [],
        repositories: [{ id: "fluent-frame-all-prs", path: "/repo/fluent-frame" }],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ waitingExternal: 1, dispatched: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:pr-review:fluent-frame-all-prs:1",
      "blocked",
      "Recovery classification: waiting-external; evidence points to an external service or execution dependency",
    );
    expect(coordinator.list()).toEqual([]);
  });

  it("blocks pending queues when a linked recovery has accepted blocked evidence", async () => {
    const runDir = join(tmpdir(), `project-recovery-current-blocked-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "blocked",
        finalVerification: "passed",
        reviewGate: { decision: "block" },
      }),
    );
    await writeFile(
      join(runDir, "system-gate.json"),
      JSON.stringify({ accepted: true, resultStatus: "blocked" }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "fluent-frame-all-prs",
      projectPath: "/repo/fluent-frame",
      source: "project-recovery",
      taskFamily: "fluent-frame-all-prs repository-pull-request-review",
      fingerprint: "unknown",
      taskId: "loop:pr-review:fluent-frame-all-prs:1",
      now: 1_000,
    });
    coordinator.linkTaskIds(
      queue.id,
      [
        "autopilot:1787720706612-fluent-frame-active-delegate",
        "loop:fluent-frame:active-delegated-task:1787720706612",
        "autopilot:1787723168018-fluent-frame-active-delegate",
      ],
      1_100,
    );
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:pr-review:fluent-frame-all-prs:1",
          source: "loop-engineering",
          name: "fluent-frame-all-prs repository-pull-request-review",
          status: "failed",
          repairStatus: "pending",
          scheduledAt: 1_000,
          updatedAt: 1_500,
        },
        {
          taskId: "autopilot:1787723168018-fluent-frame-active-delegate",
          source: "autopilot-delegate",
          name: "fluent-frame active delegated task",
          status: "failed",
          repairStatus: "pending",
          reportPath: join(runDir, "supervisor.md"),
          scheduledAt: 1_200,
          updatedAt: 1_500,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 1, fixed: 0, blocked: 1 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:pr-review:fluent-frame-all-prs:1",
      "blocked",
      "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
    );
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:1787723168018-fluent-frame-active-delegate",
      "blocked",
      "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "blocked",
    });
  });

  it("releases a failed delegated recovery immediately instead of waiting for lease expiry", async () => {
    process.env.TCB_STATE_DIR = join(tmpdir(), `project-recovery-failed-${Date.now()}`);
    writeLoopSupervisorWorkOrderState({
      workOrder: {
        id: "failed-recovery",
        projectId: "geo",
        projectName: "Geo",
        projectPath: "/repo/geo",
        scheduledAt: 1_000,
        requiredFinalMarker: "[done]",
        task: { kind: "active-delegated-task" },
      } as never,
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "invalid-output",
      now: 1_500,
    });
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "orphaned-worker",
      taskId: "loop:geo:bug-fix:8",
      now: 1_000,
    });
    coordinator.linkTaskIds(queue.id, ["autopilot:failed-recovery"], 1_000);
    coordinator.claimIds([queue.id], { now: 1_001, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queue.id, "recovery", 1_001);
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:8",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          repairStatus: "running",
          scheduledAt: 1_000,
          updatedAt: 1_500,
        },
        {
          taskId: "autopilot:failed-recovery",
          source: "autopilot-delegate",
          name: "geo active delegated task",
          status: "failed",
          repairStatus: "pending",
          scheduledAt: 1_100,
          updatedAt: 1_500,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 1, fixed: 0, blocked: 0 });
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "pending",
      nextAttemptAt: 2_000,
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:8",
      "pending",
      expect.stringContaining("returned to the repair queue"),
    );
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:failed-recovery",
      "pending",
      expect.stringContaining("returned to the repair queue"),
    );
  });

  it("terminalizes accepted blocked delegated recovery instead of dispatching it again", async () => {
    const runDir = join(tmpdir(), `project-recovery-accepted-blocked-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "blocked",
        projectId: "geo",
        actionsTaken: ["verified no project-owned source bug"],
        delegatedTasks: [],
        finalVerification: "passed",
        reviewGate: { decision: "block" },
        commits: [],
        followUps: ["External system action is required before retrying."],
      }),
    );
    await writeFile(
      join(runDir, "system-gate.json"),
      JSON.stringify({
        accepted: true,
        resultStatus: "blocked",
        workOrderId: "blocked-recovery",
        projectId: "geo",
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "worker-not-consumed",
      taskId: "loop:geo:bug-fix:9",
      now: 1_000,
    });
    coordinator.linkTaskIds(queue.id, ["autopilot:blocked-recovery"], 1_000);
    coordinator.claimIds([queue.id], { now: 1_001, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queue.id, "recovery", 1_001);
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:9",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          repairStatus: "running",
          scheduledAt: 1_000,
          updatedAt: 1_500,
        },
        {
          taskId: "autopilot:blocked-recovery",
          source: "autopilot-delegate",
          name: "geo active delegated task",
          status: "failed",
          repairStatus: "pending",
          error: "active delegation ended with blocked",
          reportPath: runDir,
          scheduledAt: 1_100,
          updatedAt: 1_500,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toMatchObject({ fixed: 0, blocked: 1 });
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "blocked",
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:9",
      "blocked",
      expect.stringContaining("accepted blocked project recovery"),
    );
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:blocked-recovery",
      "blocked",
      expect.stringContaining("accepted blocked project recovery"),
    );
  });

  it("returns accepted blocked source-branch divergence to the recovery queue", async () => {
    const runDir = join(tmpdir(), `project-recovery-source-diverged-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "blocked",
        projectId: "alcove",
        actionsTaken: [
          "Verified the source worktree dev is neither ancestor nor descendant of origin/dev.",
        ],
        delegatedTasks: [],
        finalVerification: "passed",
        reviewGate: { decision: "block" },
        commits: [],
        followUps: ["Reconcile source branch divergence before retrying project recovery."],
      }),
    );
    await writeFile(
      join(runDir, "system-gate.json"),
      JSON.stringify({
        accepted: true,
        resultStatus: "blocked",
        workOrderId: "blocked-recovery",
        projectId: "alcove",
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "alcove",
      projectPath: "/repo/alcove",
      source: "project-recovery",
      taskFamily: "alcove pull-request-review",
      fingerprint: "source-branch-diverged",
      taskId: "loop:alcove:pull-request-review:1",
      now: 1_000,
    });
    coordinator.linkTaskIds(queue.id, ["autopilot:blocked-recovery"], 1_000);
    coordinator.claimIds([queue.id], { now: 1_001, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queue.id, "recovery", 1_001);
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:alcove:pull-request-review:1",
          source: "loop-engineering",
          name: "alcove pull-request-review",
          status: "failed",
          repairStatus: "running",
          scheduledAt: 1_000,
          updatedAt: 1_500,
        },
        {
          taskId: "autopilot:blocked-recovery",
          source: "autopilot-delegate",
          name: "alcove active delegated task",
          status: "failed",
          repairStatus: "pending",
          error: "active delegation ended with blocked",
          reportPath: runDir,
          scheduledAt: 1_100,
          updatedAt: 1_500,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 2, fixed: 0, blocked: 0 });
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "pending",
      nextAttemptAt: 2_000,
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:alcove:pull-request-review:1",
      "pending",
      expect.stringContaining("returned to the repair queue"),
    );
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:blocked-recovery",
      "pending",
      expect.stringContaining("returned to the repair queue"),
    );
  });

  it("terminalizes stale pending recoveries already closed by accepted blocked evidence", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "active delegated task",
      fingerprint: "unknown",
      taskId: "autopilot:blocked-recovery",
      summary:
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      now: 1_000,
    });

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [],
      coordinator,
      updateRepairStatus: vi.fn(),
    });

    expect(result).toEqual({ checked: 0, fixed: 0, blocked: 1 });
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "blocked",
      updatedAt: 2_000,
    });
  });

  it("does not classify a successful original task as an incomplete recovery", async () => {
    const root = join(tmpdir(), `project-recovery-success-${Date.now()}`);
    const runDir = join(root, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        finalVerification: "passed",
        reviewGate: { decision: "block" },
      }),
    );
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:success",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "success",
          reportPath: join(runDir, "supervisor-final-summary.json"),
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      coordinator: new RepairCoordinator(new InMemoryRepairQueueStore()),
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 0, fixed: 0, blocked: 0 });
    expect(updateRepairStatus).not.toHaveBeenCalled();
  });

  it("reuses a due pending project recovery instead of creating another queue record", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "older-worker-handoff",
      taskId: "loop:geo:bug-fix:4",
      now: 1_000,
    });
    const dispatch = vi.fn(async () => ({ status: "queued" as const, runId: "recovery-4" }));
    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:5",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: 1_500,
          updatedAt: 1_900,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus: vi.fn(),
      dispatch,
      canonicalize: (path) => path,
    });
    expect(result).toMatchObject({ enqueued: 0, dispatched: 1 });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(coordinator.list()).toHaveLength(1);
  });

  it("blocks a delegated recovery when the authoritative summary fails verification", async () => {
    const root = join(tmpdir(), `project-recovery-blocked-${Date.now()}`);
    const runDir = join(root, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "blocked",
        projectId: "geo",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "failed",
        reviewGate: { decision: "block" },
        commits: [],
        followUps: [],
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "bug-fix",
      fingerprint: "blocked",
      taskId: "loop:geo:bug-fix:6",
      now: 1_000,
    });
    coordinator.claimIds([queue.id], { now: 1_001, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queue.id, "recovery", 1_001);
    const updateRepairStatus = vi.fn();
    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:6",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          reportPath: runDir,
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "running",
        },
      ],
      coordinator,
      updateRepairStatus,
    });
    expect(result).toEqual({ checked: 1, fixed: 0, blocked: 1 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:bug-fix:6",
      "blocked",
      "Authoritative supervisor final summary reports blocked recovery (status=blocked).",
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "blocked",
    });
  });

  it("terminalizes accepted blocked recoveries that proved no project repair applies", async () => {
    const root = join(tmpdir(), `project-recovery-not-reproducible-${Date.now()}`);
    const runDir = join(root, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "blocked",
        projectId: "english-pilot",
        actionsTaken: ["verified current gates and found no project-side bug"],
        delegatedTasks: [],
        finalVerification: "passed",
        reviewGate: {
          decision: "block",
          deterministicGates: [{ name: "tests", result: "passed" }],
        },
        commits: [],
        followUps: ["repair worker/control reconciliation in tmux-claude-bot"],
      }),
    );
    await writeFile(
      join(runDir, "system-gate.json"),
      JSON.stringify({
        accepted: true,
        resultStatus: "blocked",
      }),
    );
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queue = coordinator.enqueue({
      projectId: "english-pilot",
      projectPath: "/repo/english-pilot",
      source: "project-recovery",
      taskFamily: "active delegated task",
      fingerprint: "invalid-final-summary",
      taskId: "autopilot:1786946946679-english-pilot-active-delegate",
      now: 1_000,
    });
    coordinator.claimIds([queue.id], { now: 1_001, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queue.id, "recovery", 1_001);
    const updateRepairStatus = vi.fn();

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:1786946946679-english-pilot-active-delegate",
          source: "autopilot-delegate",
          name: "english-pilot active delegated task",
          status: "failed",
          failureKind: "invalid-final-summary",
          reportPath: runDir,
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "running",
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 1, fixed: 0, blocked: 1 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:1786946946679-english-pilot-active-delegate",
      "not-reproducible",
      expect.stringContaining("no project repair was applicable"),
    );
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "not-reproducible",
    });
  });

  it("does not mutate a running ledger item when its final artifact is absent", async () => {
    const updateRepairStatus = vi.fn();
    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:bug-fix:7",
          source: "loop-engineering",
          name: "geo bug-fix",
          status: "failed",
          reportPath: "/missing/supervisor.md",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "running",
        },
      ],
      coordinator: new RepairCoordinator(new InMemoryRepairQueueStore()),
      updateRepairStatus,
    });
    expect(result).toEqual({ checked: 0, fixed: 0, blocked: 0 });
    expect(updateRepairStatus).not.toHaveBeenCalled();
  });

  it("queues and dispatches retryable configured projects but stops owner decisions", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const dispatch = vi.fn(async () => ({ status: "queued" as const, runId: "recovery-1" }));

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:alcove:architecture:1000",
          source: "loop-engineering",
          name: "alcove architecture",
          status: "failed",
          summary: "supervisor-failed because the worker handoff did not start",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
        {
          taskId: "loop:geo:pull-request-review:1002",
          source: "loop-engineering",
          name: "geo pull-request-review",
          status: "failed",
          summary:
            "Recovery classification: needs-owner-decision; failure evidence is not specific enough",
          scheduledAt: 1_002,
          updatedAt: 1_500,
          repairStatus: "blocked",
          reportPath: "/missing/supervisor.md",
        },
        {
          taskId: "loop:geo:pull-request-review:1001",
          source: "loop-engineering",
          name: "geo pull-request-review",
          status: "failed",
          summary: "PR is draft and mergeable=CONFLICTING",
          scheduledAt: 1_001,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [
          { id: "alcove", name: "Alcove", path: "/repo/alcove" },
          { id: "geo", name: "Geo", path: "/repo/geo" },
        ],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ classified: 3, enqueued: 1, dispatched: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:pull-request-review:1001",
      "blocked",
      expect.stringContaining("needs-owner-decision"),
    );
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:pull-request-review:1002",
      "blocked",
      expect.stringContaining("needs-owner-decision"),
    );
    expect(coordinator.list()).toHaveLength(1);
  });

  it("classifies recovery evidence from a run directory instead of falling back to owner decision", async () => {
    const root = join(tmpdir(), `project-recovery-directory-evidence-${Date.now()}`);
    const reportPath = join(root, "run");
    process.env.TCB_STATE_DIR = join(root, "state");
    await mkdir(reportPath, { recursive: true });
    await writeFile(
      join(reportPath, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        actionsTaken: ["recovered a failed worktree branch preparation"],
      }),
    );
    await writeFile(
      join(reportPath, "system-gate.json"),
      JSON.stringify({ accepted: false, resultStatus: "supervisor-failed" }),
    );
    const dispatch = vi.fn(async () => ({ status: "queued" as const, runId: "recovery-2" }));

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:run-1-geo-active-delegate",
          source: "autopilot-delegate",
          name: "geo active delegated task",
          status: "failed",
          error: "terminal summary status=blocked",
          summary:
            "Recovery classification: needs-owner-decision; failure evidence is not specific enough",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "blocked",
          reportPath,
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator: new RepairCoordinator(new InMemoryRepairQueueStore()),
      updateRepairStatus: vi.fn(),
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ ownerDecision: 0, enqueued: 1, dispatched: 1 });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("queues and dispatches failed Autopilot delegations for configured projects", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const dispatch = vi.fn(async () => ({
      status: "queued" as const,
      runId: "recovery-autopilot",
    }));

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:1785948345737-alcove-active-delegate",
          source: "autopilot-delegate",
          name: "alcove active delegated task",
          status: "failed",
          error: "invalid-summary",
          failureKind: "invalid-final-summary",
          summary:
            "Active delegated task did not pass its final execution or system acceptance gate.",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "alcove", name: "Alcove", path: "/repo/alcove" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ classified: 1, enqueued: 1, dispatched: 1 });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:1785948345737-alcove-active-delegate",
      "running",
      expect.stringContaining("Project recovery delegated"),
    );
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]?.linkedTaskIds).toEqual([
      "autopilot:1785948345737-alcove-active-delegate",
      "autopilot:recovery-autopilot",
    ]);
  });

  it("deduplicates repeated project recovery evidence while linking all source tasks", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const summary =
      "loop-engineering schedule discovered; no explicit run record was found yet; Reconciled missing expected task after its scheduled time passed without a run record.";

    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:tmux-claude-bot:bug-fix:1",
          source: "loop-engineering",
          name: "tmux-claude-bot bug-fix",
          status: "failed",
          summary,
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
        {
          taskId: "loop:tmux-claude-bot:security-maintenance:2",
          source: "loop-engineering",
          name: "tmux-claude-bot security-maintenance",
          status: "failed",
          summary,
          scheduledAt: 1_100,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "tmux-claude-bot", name: "tmux-claude-bot", path: "/repo/bot" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus: vi.fn(),
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ classified: 2, enqueued: 1 });
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]).toMatchObject({
      fingerprint: summary,
      linkedTaskIds: [
        "loop:tmux-claude-bot:bug-fix:1",
        "loop:tmux-claude-bot:security-maintenance:2",
      ],
    });
  });

  it("closes the original task when its project recovery delegation succeeds", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const queueRecord = coordinator.enqueue({
      projectId: "alcove",
      projectPath: "/repo/alcove",
      source: "project-recovery",
      taskFamily: "alcove active delegated task",
      fingerprint: "invalid-summary",
      taskId: "autopilot:original",
      now: 1_000,
    });
    coordinator.linkTaskIds(queueRecord.id, ["autopilot:recovery"], 1_001);
    coordinator.claimIds([queueRecord.id], { now: 1_002, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queueRecord.id, "recovery", 1_003);

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:original",
          source: "autopilot-delegate",
          name: "alcove active delegated task",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "running",
          updatedAt: 1_003,
        },
        {
          taskId: "autopilot:recovery",
          source: "autopilot-delegate",
          name: "alcove active delegated task",
          scheduledAt: 1_004,
          status: "success",
          repairStatus: "not-needed",
          updatedAt: 1_999,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toMatchObject({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:original",
      "fixed",
      expect.stringContaining("project recovery delegation"),
    );
    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });
  });

  it("closes stale blocked originals when their linked project recovery delegation succeeds", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const queueRecord = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "tmux-claude-bot active delegated task",
      fingerprint: "unknown",
      taskId: "autopilot:lease-failure",
      now: 1_000,
    });
    coordinator.linkTaskIds(queueRecord.id, ["autopilot:successful-recovery"], 1_001);

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:lease-failure",
          source: "autopilot-delegate",
          name: "tmux-claude-bot active delegated task",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "blocked",
          error: "queued task could not acquire its supervisor lease",
          updatedAt: 1_003,
        },
        {
          taskId: "autopilot:successful-recovery",
          source: "autopilot-delegate",
          name: "tmux-claude-bot active delegated task",
          scheduledAt: 1_004,
          status: "success",
          repairStatus: "not-needed",
          updatedAt: 1_999,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toMatchObject({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:lease-failure",
      "fixed",
      expect.stringContaining("project recovery delegation"),
    );
    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });
  });

  it("closes a terminal blocked project recovery record when a linked recovery later succeeds", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const queueRecord = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "tmux-claude-bot security-maintenance",
      fingerprint: "missing-run-record",
      taskId: "loop:tmux-claude-bot:automation-governance-review:1787538900000",
      now: 1_000,
    });
    coordinator.markTerminal(queueRecord.id, "blocked", 1_001);
    coordinator.linkTaskIds(
      queueRecord.id,
      ["autopilot:1787540909921-tmux-claude-bot-active-delegate"],
      1_002,
    );

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:tmux-claude-bot:automation-governance-review:1787538900000",
          source: "loop-engineering",
          name: "tmux-claude-bot automation-governance-review",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "blocked",
          summary: "Authoritative supervisor final summary reports blocked recovery.",
          updatedAt: 1_003,
        },
        {
          taskId: "autopilot:1787540909921-tmux-claude-bot-active-delegate",
          source: "autopilot-delegate",
          name: "tmux-claude-bot active delegated task",
          scheduledAt: 1_004,
          status: "success",
          repairStatus: "not-needed",
          summary:
            "Original task loop:tmux-claude-bot:automation-governance-review:1787538900000 is fixed by merged PR #206.",
          updatedAt: 1_999,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toMatchObject({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:tmux-claude-bot:automation-governance-review:1787538900000",
      "fixed",
      expect.stringContaining("project recovery delegation"),
    );
    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });
  });

  it("keeps terminal blocked project recovery records closed without linked recovery evidence", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const queueRecord = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "tmux-claude-bot security-maintenance",
      fingerprint: "missing-run-record",
      taskId: "loop:tmux-claude-bot:security-maintenance:1787332800000",
      now: 1_000,
    });
    coordinator.markTerminal(queueRecord.id, "blocked", 1_001);

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:tmux-claude-bot:security-maintenance:1787332800000",
          source: "loop-engineering",
          name: "tmux-claude-bot security-maintenance",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "blocked",
          summary: "Authoritative supervisor final summary reports blocked recovery.",
          updatedAt: 1_003,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toEqual({ checked: 0, fixed: 0, blocked: 0 });
    expect(updateRepairStatus).not.toHaveBeenCalled();
    expect(coordinator.list()[0]).toMatchObject({ status: "blocked" });
  });

  it("closes legacy loop-engineering queue records when their linked project recovery succeeds", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const queueRecord = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "loop-engineering",
      taskFamily: "tmux-claude-bot architecture",
      fingerprint: "unknown",
      taskId: "loop:tmux-claude-bot:1000",
      now: 1_000,
    });
    coordinator.linkTaskIds(queueRecord.id, ["autopilot:successful-recovery"], 1_001);

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:tmux-claude-bot:1000",
          source: "loop-engineering",
          name: "tmux-claude-bot architecture",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "pending",
          error: "assessment result did not include a numeric score",
          updatedAt: 1_003,
        },
        {
          taskId: "autopilot:successful-recovery",
          source: "autopilot-delegate",
          name: "tmux-claude-bot active delegated task",
          scheduledAt: 1_004,
          status: "success",
          repairStatus: "not-needed",
          updatedAt: 1_999,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toMatchObject({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:tmux-claude-bot:1000",
      "fixed",
      expect.stringContaining("project recovery delegation"),
    );
    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });
  });

  it("closes the original task when a later recovery succeeds after an earlier failed attempt", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const queueRecord = coordinator.enqueue({
      projectId: "alcove",
      projectPath: "/repo/alcove",
      source: "project-recovery",
      taskFamily: "alcove active delegated task",
      fingerprint: "invalid-summary",
      taskId: "autopilot:original",
      now: 1_000,
    });
    coordinator.linkTaskIds(queueRecord.id, ["autopilot:failed-recovery"], 1_001);
    coordinator.linkTaskIds(queueRecord.id, ["autopilot:successful-recovery"], 1_002);
    coordinator.claimIds([queueRecord.id], { now: 1_003, leaseId: "recovery", limit: 1 });
    coordinator.markRunning(queueRecord.id, "recovery", 1_004);

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "autopilot:original",
          source: "autopilot-delegate",
          name: "alcove active delegated task",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "running",
          updatedAt: 1_004,
        },
        {
          taskId: "autopilot:failed-recovery",
          source: "autopilot-delegate",
          name: "alcove active delegated task",
          scheduledAt: 1_005,
          status: "failed",
          repairStatus: "pending",
          updatedAt: 1_500,
        },
        {
          taskId: "autopilot:successful-recovery",
          source: "autopilot-delegate",
          name: "alcove active delegated task",
          scheduledAt: 1_006,
          status: "success",
          repairStatus: "not-needed",
          updatedAt: 1_999,
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toMatchObject({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "autopilot:original",
      "fixed",
      expect.stringContaining("project recovery delegation"),
    );
    expect(updateRepairStatus).not.toHaveBeenCalledWith(
      "autopilot:original",
      "pending",
      expect.any(String),
    );
    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });
  });

  it("closes a pending project recovery when an unlinked successful recovery summary names the original task", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const queueRecord = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine security-maintenance",
      fingerprint: "unknown",
      taskId: "loop:knowledge-engine:security-maintenance:1786636200000",
      now: 1_000,
    });

    const result = await reconcileProjectRecoveryArtifacts({
      now: 2_000,
      records: [
        {
          taskId: "loop:knowledge-engine:security-maintenance:1786636200000",
          source: "loop-engineering",
          name: "knowledge-engine security-maintenance",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "pending",
          updatedAt: 1_500,
        },
        {
          taskId: "autopilot:successful-recovery",
          source: "autopilot-delegate",
          name: "knowledge-engine active delegated task",
          scheduledAt: 1_600,
          status: "success",
          repairStatus: "not-needed",
          updatedAt: 1_999,
          summary:
            "Per-original-task final repair status: loop:knowledge-engine:security-maintenance:1786636200000 completed-no-delta.",
        },
      ],
      coordinator,
      updateRepairStatus,
    });

    expect(result).toMatchObject({ checked: 1, fixed: 1, blocked: 0 });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:knowledge-engine:security-maintenance:1786636200000",
      "fixed",
      expect.stringContaining("project recovery delegation"),
    );
    expect(coordinator.list().find((record) => record.id === queueRecord.id)).toMatchObject({
      status: "fixed",
    });
  });

  it("blocks external waits without dispatching them", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const updateRepairStatus = vi.fn();
    const dispatch = vi.fn();
    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:security-maintenance:1000",
          source: "loop-engineering",
          name: "geo security-maintenance",
          status: "failed",
          summary: "GitHub runner is unavailable",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({
      classified: 1,
      enqueued: 0,
      dispatched: 0,
      waitingExternal: 1,
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:security-maintenance:1000",
      "blocked",
      "Recovery classification: waiting-external; evidence points to an external service or execution dependency",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("queues retryable work without claiming it when dispatch is not configured", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:architecture:1006",
          source: "loop-engineering",
          name: "geo architecture",
          status: "failed",
          summary: "supervisor-failed because worker handoff failed",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus: vi.fn(),
      canonicalize: (path) => path,
    });

    expect(result).toMatchObject({ classified: 1, enqueued: 1, dispatched: 0 });
    expect(coordinator.list()[0]).toMatchObject({ status: "pending" });
  });

  it("keeps stale external waits blocked when better evidence is found", async () => {
    const updateRepairStatus = vi.fn();
    await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:security-maintenance:1003",
          source: "loop-engineering",
          name: "geo security-maintenance",
          status: "failed",
          summary:
            "Recovery classification: needs-owner-decision; failure evidence is not specific enough",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "blocked",
          reportPath: "/missing/supervisor.md",
          error: "runner is unavailable",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator: new RepairCoordinator(new InMemoryRepairQueueStore()),
      updateRepairStatus,
      canonicalize: (path) => path,
    });
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:security-maintenance:1003",
      "blocked",
      expect.stringContaining("waiting-external"),
    );
  });

  it("marks unavailable configured paths as owner decisions", async () => {
    const updateRepairStatus = vi.fn();
    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:architecture:1004",
          source: "loop-engineering",
          name: "geo architecture",
          status: "failed",
          summary: "supervisor-failed",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator: new RepairCoordinator(new InMemoryRepairQueueStore()),
      updateRepairStatus,
      canonicalize: (path) => path,
      verifyProjectPath: () => false,
    });
    expect(result.unconfigured).toBe(1);
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:architecture:1004",
      "blocked",
      expect.stringContaining("configured project is unavailable"),
    );
  });

  it("dead-letters a project recovery after the persisted retry limit", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queued = coordinator.enqueue({
      projectId: "geo",
      projectPath: "/repo/geo",
      source: "project-recovery",
      taskFamily: "architecture",
      fingerprint: "supervisor-failed",
      taskId: "loop:geo:architecture:1005",
      now: 1_000,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      coordinator.claimIds([queued.id], {
        now: 1_100 + attempt * 100,
        leaseId: `lease-${attempt}`,
        limit: 1,
      });
      coordinator.releaseForRetry(queued.id, 1_101 + attempt * 100);
    }
    const updateRepairStatus = vi.fn();
    const result = await runProjectRecoveryPass({
      now: 2_000,
      records: [
        {
          taskId: "loop:geo:architecture:1005",
          source: "loop-engineering",
          name: "geo architecture",
          status: "failed",
          summary: "supervisor-failed",
          scheduledAt: 1_000,
          updatedAt: 1_500,
          repairStatus: "pending",
        },
      ],
      config: {
        projects: [{ id: "geo", name: "Geo", path: "/repo/geo" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      canonicalize: (path) => path,
    });
    expect(result.deadLetter).toBe(1);
    expect(updateRepairStatus).toHaveBeenCalledWith(
      "loop:geo:architecture:1005",
      "blocked",
      expect.stringContaining("attempt limit"),
    );
  });
});
