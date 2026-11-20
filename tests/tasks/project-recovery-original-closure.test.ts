import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileProjectRecoveryArtifacts,
  runProjectRecoveryPass,
} from "../../src/core/tasks/project-recovery-service.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const registryMock = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../../src/core/loop/supervisor-state.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/loop/supervisor-state.js")>();
  return {
    ...original,
    readLoopSupervisorWorkOrderRegistry: (now: number) =>
      registryMock.value ?? original.readLoopSupervisorWorkOrderRegistry(now),
  };
});

const closure =
  "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.";
const originalStateDir = process.env.TCB_STATE_DIR;
beforeEach(() => {
  registryMock.value = undefined;
  process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-original-closure-"));
});
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function fixture(error?: string, attempt = 0) {
  const ledger = new DailyTaskLedger();
  const taskId = "loop:suite:bug-fix:1000";
  ledger.expect({ taskId, source: "loop-engineering", name: "suite bug-fix", scheduledAt: 1000 });
  if (error === undefined) ledger.reconcileExpectedMissing(1001);
  else ledger.fail(taskId, { endedAt: 1001, error });
  ledger.markRepairStatus(taskId, { repairStatus: "blocked", updatedAt: 1100, summary: closure });
  const store = new InMemoryRepairQueueStore();
  const coordinator = new RepairCoordinator(store);
  const queue = coordinator.enqueue({
    projectId: "suite",
    projectPath: "/repo/suite",
    source: "project-recovery",
    taskFamily: "suite bug-fix",
    fingerprint:
      error === undefined ? "missing-run-record" : (ledger.listAll()[0]?.failureKind ?? "unknown"),
    taskId,
    summary: closure,
    now: 1100,
  });
  store.set(queue.id, { ...queue, status: "blocked", attempt });
  const updateRepairStatus = (
    id: string,
    repairStatus: Parameters<DailyTaskLedger["markRepairStatus"]>[1]["repairStatus"],
    summary: string,
  ) => {
    ledger.markRepairStatus(id, { repairStatus, updatedAt: 2000, summary });
  };
  const reconcile = () =>
    reconcileProjectRecoveryArtifacts({
      now: 2000,
      records: ledger.listAll(),
      coordinator,
      updateRepairStatus,
    });
  const dispatch = vi.fn(async () => ({
    status: "blocked" as const,
    detail: "automation admission deferred: quiet-hours",
  }));
  const pass = () =>
    runProjectRecoveryPass({
      now: 2000,
      records: ledger
        .listAll()
        .filter(
          (r): r is typeof r & { repairStatus: "pending" | "blocked" } =>
            r.repairStatus === "pending" || r.repairStatus === "blocked",
        ),
      config: {
        projects: [{ id: "suite", name: "Suite", path: "/repo/suite" }],
        repositories: [],
        workspaces: [],
      },
      coordinator,
      updateRepairStatus,
      dispatch,
      canonicalize: (path) => path,
    });
  return { ledger, taskId, store, coordinator, queue, reconcile, pass, dispatch };
}

describe("original task evidence survives generic accepted-blocked closure", () => {
  it.each([
    undefined,
    "Cannot verify live agent identity for managed context reset",
    "Codex live transcript unavailable and no fresh launch grant",
  ])("reconsiders %s and remains due on repeated reconciliation", async (error) => {
    const f = fixture(error, 1);
    await f.reconcile();
    await f.pass();
    await f.reconcile();
    await f.pass();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.ledger.listAll()[0]).toMatchObject({
      repairStatus: "pending",
      status: error === undefined ? "missing" : "failed",
    });
    expect(f.coordinator.findOpenProjectRecovery("suite")).toMatchObject({
      attempt: 1,
      status: "pending",
    });
  });

  it.each([
    "Codex live transcript unavailable for managed completion evidence",
    "Reserved worker ownership changed during context reset",
    "Codex process changed during managed context reset",
    "RalphWorks declared needs_input; no native fallback is allowed",
  ])("preserves the unsafe boundary: %s", async (error) => {
    const f = fixture(error);
    await f.reconcile();
    await f.pass();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.ledger.listAll()[0]?.repairStatus).toBe("blocked");
    expect(f.coordinator.findOpenProjectRecovery("suite")).toBeUndefined();
  });

  it("does not release a currently owned aggregate", async () => {
    const f = fixture("Cannot verify live agent identity for managed context reset");
    f.store.set(f.queue.id, {
      ...f.queue,
      status: "running",
      leaseId: "live-owner",
      leaseExpiresAt: 5000,
      workOrderId: "active-run",
    });
    const before = f.coordinator.list();
    await f.reconcile();
    expect(f.coordinator.list()).toEqual(before);
    expect(f.ledger.listAll()[0]?.repairStatus).toBe("blocked");
  });

  it.each([undefined, "Cannot verify live agent identity for managed context reset"])(
    "never recreates an exhausted original budget: %s",
    async (error) => {
      const f = fixture(error, 3);
      await f.reconcile();
      await f.pass();
      await f.reconcile();
      await f.pass();
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.coordinator.list()).toHaveLength(1);
      expect(f.coordinator.list()[0]?.attempt).toBe(3);
    },
  );

  it("keeps a genuine blocked sibling terminal while reconsidering the retryable original", async () => {
    const f = fixture("Cannot verify live agent identity for managed context reset");
    const sibling = "loop:suite:security-maintenance:1001";
    f.ledger.expect({
      taskId: sibling,
      source: "loop-engineering",
      name: "suite security",
      scheduledAt: 1001,
    });
    f.ledger.fail(sibling, { endedAt: 1002, error: "blocked" });
    f.ledger.markRepairStatus(sibling, {
      repairStatus: "blocked",
      updatedAt: 1100,
      summary: closure,
    });
    f.coordinator.linkTaskIds(f.queue.id, [sibling], 1100);
    await f.reconcile();
    const records = new Map(f.ledger.listAll().map((r) => [r.taskId, r]));
    expect(records.get(f.taskId)?.repairStatus).toBe("pending");
    expect(records.get(sibling)?.repairStatus).toBe("blocked");
  });

  it("raises a legacy unowned same-task pending budget without resetting or stalling it", async () => {
    const f = fixture(undefined, 2);
    const pending = {
      ...f.queue,
      id: "legacy-pending",
      status: "pending" as const,
      attempt: 0,
      summaries: [],
    };
    f.store.set(pending.id, pending);
    await f.reconcile();
    await f.pass();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.coordinator.list().find((r) => r.id === pending.id)).toMatchObject({
      status: "pending",
      attempt: 2,
    });
  });

  it.each(["external", "uncertain"])(
    "consults the original ordinary-loop artifact without a ledger reportPath: %s",
    async (boundary) => {
      const f = fixture();
      const runDir = join(process.env.TCB_STATE_DIR ?? "", "original-run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "supervisor-summary.json"),
        JSON.stringify({
          result: {
            reason:
              boundary === "uncertain"
                ? "Codex live transcript unavailable for managed completion evidence"
                : "External owner action required",
          },
        }),
      );
      if (boundary === "external") {
        writeFileSync(
          join(runDir, "supervisor-final-summary.json"),
          JSON.stringify({ status: "blocked", reviewGate: { decision: "block" } }),
        );
        writeFileSync(
          join(runDir, "system-gate.json"),
          JSON.stringify({
            accepted: true,
            resultStatus: "blocked",
            repairDisposition: "target-or-external-blocker",
          }),
        );
      }
      registryMock.value = {
        records: [
          {
            runDir,
            workOrder: {
              id: "original-run",
              projectId: "suite",
              scheduledAt: 1000,
              projectPath: "/repo/suite",
            },
          },
        ],
        unfinished: [],
        recoverableFinalSummary: [],
        recoverableFailed: [],
        terminal: [],
      };
      await f.reconcile();
      await f.pass();
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.ledger.listAll()[0]?.repairStatus).toBe("blocked");
    },
  );

  it("keeps a fresh occurrence at zero when another original exhausts its budget", async () => {
    const f = fixture("Cannot verify live agent identity for managed context reset", 2);
    const fresh = "loop:suite:test-coverage:1200";
    f.ledger.expect({
      taskId: fresh,
      source: "loop-engineering",
      name: "suite coverage",
      scheduledAt: 1200,
    });
    f.ledger.reconcileExpectedMissing(1300);
    await f.reconcile();
    await f.pass();
    const attempted = f.coordinator.findOpenProjectRecovery("suite");
    expect(attempted).toMatchObject({ attempt: 2 });
    expect(attempted?.linkedTaskIds).not.toContain(fresh);
    if (attempted === undefined) throw new Error("missing attempted original");
    f.coordinator.releaseForRetry(attempted.id, 2100);
    await f.pass();
    const freshQueue = f.coordinator.findOpenProjectRecovery("suite");
    expect(freshQueue).toMatchObject({ attempt: 0 });
    expect(freshQueue?.linkedTaskIds).toContain(fresh);
    expect(f.ledger.listAll().find((r) => r.taskId === fresh)?.repairStatus).toBe("pending");
  });

  it.each([2, 3])("does not lower an existing attempt when no floor is supplied: %s", (attempt) => {
    const f = fixture(undefined, attempt);
    f.store.set(f.queue.id, { ...f.queue, attempt, status: "blocked", summaries: [] });
    const reopened = f.coordinator.enqueue({
      projectId: "suite",
      projectPath: "/repo/suite",
      source: "project-recovery",
      taskFamily: "suite bug-fix",
      fingerprint: "missing-run-record",
      taskId: f.taskId,
      now: 2000,
    });
    expect(reopened.id).toBe(f.queue.id);
    expect(reopened.attempt).toBe(attempt);
    if (attempt === 3) expect(reopened.status).toBe("blocked");
  });

  it.each([false, true])(
    "preserves an authoritative recovery even in first linked slot: %s",
    async (first) => {
      const f = fixture("Cannot verify live agent identity for managed context reset");
      const runDir = join(process.env.TCB_STATE_DIR ?? "", "external-recovery");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "supervisor-final-summary.json"),
        JSON.stringify({ status: "blocked", reviewGate: { decision: "block" } }),
      );
      writeFileSync(
        join(runDir, "system-gate.json"),
        JSON.stringify({
          accepted: true,
          resultStatus: "blocked",
          repairDisposition: "target-or-external-blocker",
        }),
      );
      const taskId = "autopilot:external-recovery";
      f.ledger.expect({
        taskId,
        source: "autopilot-delegate",
        name: "suite recovery",
        scheduledAt: 1500,
      });
      f.ledger.fail(taskId, { endedAt: 1600, error: "blocked", reportPath: runDir });
      f.coordinator.linkTaskIds(f.queue.id, [taskId], 1600);
      if (first) {
        const stored = f.coordinator.list().find((r) => r.id === f.queue.id);
        if (stored === undefined) throw new Error("missing fixture queue");
        f.store.set(f.queue.id, { ...stored, linkedTaskIds: [taskId, f.taskId] });
      }
      await f.reconcile();
      await f.pass();
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.ledger.listAll().find((r) => r.taskId === f.taskId)?.repairStatus).toBe("blocked");
      expect(f.coordinator.findOpenProjectRecovery("suite")).toBeUndefined();
    },
  );
});
