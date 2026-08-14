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
    expect(coordinator.list().find((record) => record.id === queue.id)).toMatchObject({
      status: "blocked",
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

  it("keeps external waits pending without dispatching them", async () => {
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

    expect(result).toMatchObject({ classified: 1, enqueued: 0, dispatched: 0 });
    expect(updateRepairStatus).not.toHaveBeenCalled();
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

  it("reopens a stale blocked classification when the evidence is external waiting", async () => {
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
      "pending",
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
