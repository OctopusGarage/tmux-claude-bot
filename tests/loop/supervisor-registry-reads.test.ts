import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findProjectAutomationConflict,
  listReservedLoopSupervisorWorkOrders,
} from "../../src/core/automation/project-conflicts.js";
import {
  claimDelegationAttempt,
  prepareDelegationAttempt,
  settleDelegationAttempt,
} from "../../src/core/loop/delegation-attempt.js";
import {
  releaseLoopSupervisorSessions,
  reserveLoopSupervisorSessions,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import {
  hasLiveExternalExecution,
  type LoopSupervisorWorkOrderRegistry,
  type LoopSupervisorWorkOrderStateStatus,
  readLoopSupervisorWorkOrderRegistry,
} from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const NOW = 2_000_000_000;
const SESSION = "tmux_proj_registry-fixture";
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.TCB_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "tcb-registry-reads-"));
  process.env.TCB_STATE_DIR = stateDir;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  releaseLoopSupervisorSessions([SESSION]);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = previousStateDir;
});

function order(id: string): LoopWorkOrder {
  return {
    id,
    scheduledAt: 1_000,
    projectId: "registry-fixture",
    projectName: "Registry fixture",
    projectPath: join(stateDir, "project", id),
    agent: "codex",
    goal: "Verify durable registry views.",
    maxRounds: 1,
    targetScore: 90,
    runner: { kind: "agent-supervised", timeoutMs: 1_000, requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "true" },
    execution: { agent: true },
    recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: true },
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${id}]`,
    finalSummaryPath: join(
      stateDir,
      "loop-runs",
      "registry-fixture",
      id,
      "supervisor-final-summary.json",
    ),
  };
}

function run(
  id: string,
  status: LoopSupervisorWorkOrderStateStatus,
  options: {
    updatedAt?: number;
    resultStatus?: string;
    deadlineAt?: number;
    journal?: boolean;
  } = {},
): LoopWorkOrder {
  const workOrder = order(id);
  if (options.journal)
    workOrder.task = {
      kind: "active-delegated-task",
      sourceSession: "tmux_proj_fixture-source",
      requirement: "Verify durable registry views.",
      requireReview: true,
      requireTests: true,
      requireCoverageReview: true,
      allowAiEval: false,
    };
  saveRun(workOrder, status, options);
  return workOrder;
}

function saveRun(
  workOrder: LoopWorkOrder,
  status: LoopSupervisorWorkOrderStateStatus,
  options: { updatedAt?: number; resultStatus?: string; deadlineAt?: number } = {},
): void {
  const runDir = dirname(workOrder.finalSummaryPath ?? "");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "work-order.json"), JSON.stringify(workOrder));
  writeFileSync(
    join(runDir, "work-order-state.json"),
    JSON.stringify({
      status,
      projectId: workOrder.projectId,
      runId: workOrder.id,
      supervisorSession: SESSION,
      scheduledAt: workOrder.scheduledAt,
      updatedAt: options.updatedAt ?? NOW - 1_000,
      ...(options.resultStatus === undefined ? {} : { resultStatus: options.resultStatus }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    }),
  );
}

function summary(workOrder: LoopWorkOrder): void {
  writeFileSync(
    workOrder.finalSummaryPath ?? "",
    JSON.stringify({
      status: "completed",
      projectId: workOrder.projectId,
      actionsTaken: ["Verified the fixture."],
      delegatedTasks: [],
      finalVerification: "passed",
      commits: [],
      followUps: [],
    }),
  );
}

function settledJournal(workOrder: LoopWorkOrder): void {
  const prepared = prepareDelegationAttempt({
    workOrder,
    supervisorSession: SESSION,
    attemptId: "fixture-attempt",
    prompt: "Verify the fixture.",
    now: NOW - 3_000,
  });
  if (prepared === undefined) throw new Error("fixture must support delegation attempts");
  if (!claimDelegationAttempt(workOrder, prepared, NOW - 2_000))
    throw new Error("fixture attempt must be claimable");
  summary(workOrder);
  if (
    !settleDelegationAttempt(
      workOrder,
      prepared,
      { status: 0, stdout: "", stderr: "" },
      false,
      NOW - 1_000,
      true,
    )
  )
    throw new Error("fixture attempt must settle");
}

function ids(records: LoopSupervisorWorkOrderRegistry["records"]): string[] {
  return records.map(({ workOrder }) => workOrder.id).sort();
}

function readsEndingWith(name: string): number {
  return vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path).endsWith(name)).length;
}

describe("fresh registry reads", () => {
  it("does not read delegation journals for hundreds of completed and cancelled historical runs", () => {
    for (let index = 0; index < 240; index++) {
      const historical = run(`history-${index}`, index % 2 === 0 ? "completed" : "cancelled", {
        journal: true,
      });
      settledJournal(historical);
    }
    const pending = run("current", "in-flight", { journal: true });
    settledJournal(pending);
    vi.clearAllMocks();

    const registry = readLoopSupervisorWorkOrderRegistry(NOW);
    const historicalReads = vi
      .mocked(readFileSync)
      .mock.calls.filter(([path]) => /\/history-\d+\/iteration-attempts\//.test(String(path)));
    expect(historicalReads.length).toBe(0);
    expect(readsEndingWith("/current/iteration-attempts/first.json")).toBe(1);
    expect(registry.terminal).toHaveLength(240);
    expect(ids(registry.recoverableFinalSummary)).toEqual(["current"]);
  });

  it("preserves explicit lifecycle views for mixed legacy, journal, failed, and stale records", () => {
    run("active", "in-flight");
    summary(run("summary-ready", "in-flight", { updatedAt: NOW - 13 * 60 * 60_000 }));
    summary(run("failed-ready", "failed", { resultStatus: "dispatch-failed" }));
    const gated = run("failed-gated", "failed", { resultStatus: "dispatch-failed" });
    summary(gated);
    writeFileSync(join(dirname(gated.finalSummaryPath ?? ""), "system-gate.json"), "{}");
    const malformed = run("malformed-journal", "in-flight", { journal: true });
    summary(malformed);
    const attempts = join(dirname(malformed.finalSummaryPath ?? ""), "iteration-attempts");
    mkdirSync(attempts);
    writeFileSync(join(attempts, "first.json"), "{broken");
    run("stale-dispatch", "dispatching", { updatedAt: NOW - 6 * 60_000 });
    run("abandoned", "in-flight", { updatedAt: NOW - 13 * 60 * 60_000 });
    settledJournal(
      run("failed-journal", "failed", { resultStatus: "invalid-output", journal: true }),
    );
    run("failed-not-recoverable", "failed", { resultStatus: "completed", journal: true });

    const registry = readLoopSupervisorWorkOrderRegistry(NOW);

    expect(ids(registry.unfinished)).toEqual(["active", "malformed-journal", "stale-dispatch"]);
    expect(ids(registry.recoverableFinalSummary)).toEqual(["summary-ready"]);
    expect(ids(registry.recoverableFailed)).toEqual(["failed-journal", "failed-ready"]);
    expect(ids(registry.abandoned)).toEqual(["abandoned"]);
    expect(ids(registry.staleDispatching)).toEqual(["stale-dispatch"]);
    expect(ids(registry.terminal)).toEqual([
      "failed-gated",
      "failed-journal",
      "failed-not-recoverable",
      "failed-ready",
    ]);
  });

  it("retains exact live external reservation evidence and sees state changes on the next call", () => {
    const external = run("external-owner", "in-flight", { deadlineAt: NOW + 60_000 });
    external.task = { kind: "architecture", implementation: { kind: "ralphworks" } };
    saveRun(external, "in-flight", { deadlineAt: NOW + 60_000 });
    reserveLoopSupervisorSessions([SESSION], new Set());
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: SESSION,
          workOrderId: external.id,
          projectId: external.projectId,
          projectPath: external.projectPath,
          status: "active",
          leasedAt: NOW - 1_000,
          updatedAt: NOW - 1_000,
        },
      ],
    });
    const before = readLoopSupervisorWorkOrderRegistry(NOW);
    expect(ids(before.unfinished)).toEqual([external.id]);
    expect(before.records.some((record) => hasLiveExternalExecution(record, NOW))).toBe(true);

    saveRun(external, "in-flight", {
      updatedAt: NOW - 13 * 60 * 60_000,
      deadlineAt: NOW + 60_000,
    });
    const aged = readLoopSupervisorWorkOrderRegistry(NOW);
    expect(aged.unfinished).toEqual([]);
    expect(aged.records.some((record) => hasLiveExternalExecution(record, NOW))).toBe(true);

    saveRun(external, "completed");
    const after = readLoopSupervisorWorkOrderRegistry(NOW);
    expect(after.unfinished).toEqual([]);
    expect(ids(after.terminal)).toEqual([external.id]);
    expect(after.records.some((record) => hasLiveExternalExecution(record, NOW))).toBe(false);
  });

  it("reads one durable snapshot for each conflict lookup and refreshes it on the next call", () => {
    for (let index = 0; index < 120; index++) run(`history-${index}`, "completed");
    const active = run("active", "in-flight");
    const failed = run("failed-ready", "failed", { resultStatus: "dispatch-failed" });
    summary(failed);
    const ready = run("summary-ready", "in-flight");
    summary(ready);
    vi.clearAllMocks();

    expect(findProjectAutomationConflict(active.projectPath)?.runId).toBe(active.id);
    expect(readsEndingWith("/work-order-state.json")).toBe(123);
    expect(readsEndingWith("/work-order.json")).toBe(123);
    expect(ids(listReservedLoopSupervisorWorkOrders())).toEqual([
      "active",
      "failed-ready",
      "summary-ready",
    ]);

    saveRun(active, "completed");
    expect(findProjectAutomationConflict(active.projectPath)).toBeNull();
    expect(findProjectAutomationConflict(failed.projectPath)?.runId).toBe(failed.id);
  });

  it("does not probe delegation recovery for completed runs with absent journals", () => {
    run("completed-legacy", "completed", { journal: true });
    vi.clearAllMocks();
    readLoopSupervisorWorkOrderRegistry(NOW);
    const probes = vi
      .mocked(lstatSync)
      .mock.calls.filter(([path]) => String(path).endsWith("/iteration-attempts"));
    expect(probes.length).toBe(0);
  });
});
