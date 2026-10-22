import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectRecoveryPass } from "../../src/core/tasks/project-recovery-service.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
  type RepairQueueRecord,
} from "../../src/core/tasks/repair-coordinator.js";

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "project-recovery-deferral-"));
  process.env.TCB_STATE_DIR = stateDir;
});
afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

function setup(overrides: Partial<RepairQueueRecord> = {}) {
  const store = new InMemoryRepairQueueStore();
  const coordinator = new RepairCoordinator(store);
  const record = coordinator.enqueue({
    projectId: "sample",
    projectPath: "/repo/sample",
    source: "project-recovery",
    taskFamily: "sample bug-fix",
    fingerprint: "missing-run-record",
    taskId: "loop:sample:bug-fix:1000",
    now: 1000,
  });
  store.set(record.id, { ...record, nextAttemptAt: 86_400_000, ...overrides });
  return { store, id: record.id, coordinator: new RepairCoordinator(store) };
}
function pass(
  coordinator: RepairCoordinator,
  now: number,
  dispatch: NonNullable<Parameters<typeof runProjectRecoveryPass>[0]["dispatch"]>,
) {
  return runProjectRecoveryPass({
    now,
    coordinator,
    dispatch,
    records: [
      {
        taskId: "loop:sample:bug-fix:1000",
        source: "loop-engineering",
        name: "sample bug-fix",
        scheduledAt: 1000,
        updatedAt: 1000,
        status: "missing",
        summary:
          "Reconciled missing expected task after its scheduled time passed without a run record.",
        repairStatus: "pending",
      },
    ],
    config: {
      projects: [{ id: "sample", name: "Sample", path: "/repo/sample" }],
      repositories: [],
      workspaces: [],
    },
    canonicalize: (path) => path,
    verifyProjectPath: () => true,
    updateRepairStatus: vi.fn(),
  });
}

describe("project recovery admission rechecks", () => {
  it("rechecks a persisted never-dispatched deferral through admission after capacity recovers", async () => {
    const { store, id, coordinator } = setup();
    const dispatch = vi.fn(async () => ({ status: "queued" as const, runId: "recovered" }));
    expect(await pass(coordinator, 2000, dispatch)).toMatchObject({ dispatched: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.get(id)).toMatchObject({
      status: "running",
      attempt: 0,
      linkedTaskIds: ["loop:sample:bug-fix:1000", "autopilot:recovered"],
    });
    await pass(new RepairCoordinator(store), 3000, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a closed gate pending and rechecks on a bounded clock without consuming attempts", async () => {
    const { store, id, coordinator } = setup();
    const dispatch = vi.fn(async () => ({
      status: "blocked" as const,
      detail: "automation admission deferred: quiet-hours",
      retryAt: 86_400_000,
    }));
    expect(await pass(coordinator, 2000, dispatch)).toMatchObject({ dispatched: 0, deferred: 1 });
    expect(store.get(id)).toMatchObject({ status: "pending", attempt: 0, nextAttemptAt: 902_000 });
    expect(store.get(id)?.leaseId).toBeUndefined();
    await pass(new RepairCoordinator(store), 901_999, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await pass(new RepairCoordinator(store), 902_000, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.get(id)).toMatchObject({
      status: "pending",
      attempt: 0,
      nextAttemptAt: 1_802_000,
    });
  });

  it.each([
    { status: "retry-wait" as const, attempt: 1 },
    { status: "pending" as const, attempt: 1 },
    { status: "pending" as const, workOrderId: "owned" },
    { status: "pending" as const, leaseId: "owned", leaseExpiresAt: 86_400_000 },
    { status: "leased" as const, leaseId: "owned", leaseExpiresAt: 86_400_000 },
    { status: "running" as const, leaseId: "owned", leaseExpiresAt: 86_400_000 },
    { status: "pending" as const, nextAttemptAt: 5000 },
  ])("preserves retry or ownership evidence: %j", async (overrides) => {
    const { store, id, coordinator } = setup(overrides);
    const before = store.get(id);
    const dispatch = vi.fn(async () => ({ status: "queued" as const, runId: "unexpected" }));
    await pass(coordinator, 2000, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.get(id)).toMatchObject({
      status: before?.status,
      attempt: before?.attempt,
      nextAttemptAt: before?.nextAttemptAt,
    });
  });
});
