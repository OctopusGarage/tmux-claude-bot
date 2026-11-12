import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCapacityStore } from "../../src/core/automation/capacity-store.js";
import { AutonomousWorkCoordinator } from "../../src/core/automation/coordinator.js";
import {
  hasLoopExecutionQuarantine,
  quarantineLoopExecution,
} from "../../src/core/loop/execution-quarantine.js";
import * as summaryRecovery from "../../src/core/loop/final-summary-recovery.js";
import * as ralph from "../../src/core/loop/ralph-task.js";
import { LoopSchedulerStore } from "../../src/core/loop/scheduler.js";
import {
  reconcileAutonomousCapacityLeases,
  reconcileLoopSupervisorWorkOrders,
  runLoopServiceTickAsync,
} from "../../src/core/loop/service.js";
import {
  readLoopSupervisorWorkerLeaseState,
  releaseLoopSupervisorSessions,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import { reconcileTerminalSupervisorResources } from "../../src/core/loop/supervisor-resource-reconciliation.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const previousState = process.env.TCB_STATE_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  if (previousState === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = previousState;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function executingFixture(
  run: (f: {
    order: LoopWorkOrder;
    advance: (ms: number) => void;
    reconcile: () => Promise<unknown>;
    capacity: AgentCapacityStore;
    dispatch: ReturnType<typeof vi.fn>;
    state: () => { status: string; updatedAt: number };
    finish: () => void;
    fail: () => void;
    waitForEnd: () => Promise<unknown>;
    triggerStart: () => void;
  }) => Promise<void>,
  startImmediately = true,
  budgetMs = 5400000,
) {
  const stateDir = mkdtempSync(join(tmpdir(), "tcb-external-lifecycle-"));
  process.env.TCB_STATE_DIR = stateDir;
  const project = mkdtempSync(join(tmpdir(), "tcb-external-project-"));
  let clock = Date.parse("2026-10-26T13:00:00Z");
  const monotonicStart = performance.now();
  vi.spyOn(Date, "now").mockImplementation(
    () => clock + Math.floor(performance.now() - monotonicStart),
  );
  const file = join(stateDir, "loop.yml");
  writeFileSync(
    file,
    `scheduler:\n  jitter: {enabled: false}\nprojects:\n  - id: fixture\n    name: Fixture\n    path: ${project}\n    agent: codex\n    schedule: "*/5 * * * *"\n    runner: {kind: agent-supervised, timeoutMs: ${budgetMs}}\n    execution: {agent: true, architecture: {kind: ralphworks}}\n    goal: Improve coupling in one bounded change.\n    maxRounds: 1\n    targetScore: 90\n    assessment: {command: "fixture assess"}\n    allowedActions: [tests]\n`,
  );
  const entered = deferred<LoopWorkOrder>();
  const external = deferred<ralph.RalphTaskEvidence>();
  let triggerStart = () => {};
  const execute = vi.spyOn(ralph, "executeRalphTask").mockImplementation(async (input) => {
    quarantineLoopExecution(input.workOrder, "Synthetic external owner is still executing");
    triggerStart = () => input.onStarted?.();
    if (startImmediately) triggerStart();
    entered.resolve(input.workOrder);
    return external.promise;
  });
  const capacity = new AgentCapacityStore();
  capacity.ensureUnknown("codex", clock);
  const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => clock });
  const dispatch = vi.fn(async () => ({
    status: 1,
    stdout: "",
    stderr: "fixture native transport unavailable",
  }));
  const runCommand = () => ({
    status: 0,
    stdout: JSON.stringify({ score: 50, findings: [], suggestedBotImprovements: [] }),
    stderr: "",
  });
  const tick = runLoopServiceTickAsync({
    configFile: file,
    now: clock,
    schedulerStore: new LoopSchedulerStore(),
    runCommand,
    runSupervisorTask: dispatch,
    supervisorSessionName: "tmux_proj_loop-supervisor",
    ensureSupervisorSession: async () => true,
    automationCoordinator: coordinator,
    automationAgent: "codex",
  });
  void tick.catch((error: Error) => entered.reject(error));
  try {
    const order = await entered.promise;
    const state = () =>
      JSON.parse(
        readFileSync(join(dirname(order.finalSummaryPath ?? ""), "work-order-state.json"), "utf8"),
      ) as { status: string; updatedAt: number };
    const reconcile = async () => {
      const result = await reconcileLoopSupervisorWorkOrders({
        configFile: file,
        now: clock,
        runCommand,
        supervisorSessionBusy: () => false,
        workerSessionOwnsActiveTurn: () => false,
        workerSessionExists: async () => true,
      });
      await reconcileTerminalSupervisorResources({
        now: clock,
        workerSessionOwnsActiveTurn: () => false,
        workerSessionExists: async () => true,
      });
      reconcileAutonomousCapacityLeases(capacity, clock);
      return result;
    };
    await run({
      order,
      advance: (ms) => {
        clock += ms;
      },
      reconcile,
      capacity,
      dispatch,
      state,
      waitForEnd: () => tick,
      triggerStart,
      fail: () => external.reject(new Error("fixture preflight failed")),
      finish: () =>
        external.resolve({
          invocationId: "fixture",
          taskInputSha256: "fixture",
          receiptFile: "/fixture/receipt.json",
          receiptSha256: "fixture",
          archivePath: "/fixture/archive",
          profileFingerprint: "fixture",
        }),
    });
  } finally {
    external.reject(new Error("fixture external owner stopped"));
    await tick;
    execute.mockRestore();
  }
}

describe("Ralph external lifecycle integration", () => {
  it("settles a pre-start external failure without stranding dispatch ownership", async () => {
    await executingFixture(async (f) => {
      expect(f.state().status).toBe("dispatching");
      f.fail();
      await f.waitForEnd();
      expect(f.state().status).toBe("failed");
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(
        readLoopSupervisorWorkerLeaseState().leases.every((lease) => lease.status !== "active"),
      ).toBe(true);
      expect(f.capacity.read("codex", Date.now()).activeAutonomousLeases).toBe(0);
    }, false);
  });

  it("preserves the immutable original deadline across queued and revision state writes", async () => {
    await executingFixture(async (f) => {
      const original = f.state() as { deadlineAt?: number };
      expect(original.deadlineAt).toBeGreaterThan(Date.now());
      for (const status of ["queued", "in-flight", "needs-revision"] as const) {
        f.advance(1000);
        writeLoopSupervisorWorkOrderState({
          workOrder: f.order,
          supervisorSession: "tmux_proj_loop-supervisor",
          status,
          now: Date.now(),
          deadlineAt: Date.now() + 99999999,
        });
        expect((f.state() as { deadlineAt?: number }).deadlineAt).toBe(original.deadlineAt);
      }
    });
  });

  it("keeps live external work owned through full reconciliation beyond five minutes with native UI idle", async () => {
    await executingFixture(async (f) => {
      f.advance(6 * 60 * 1000);
      await f.reconcile();
      expect(f.state().status).toBe("in-flight");
      expect(readLoopSupervisorWorkerLeaseState().leases).toContainEqual(
        expect.objectContaining({ workOrderId: f.order.id, status: "active" }),
      );
      expect(f.capacity.read("codex", Date.now()).activeAutonomousLeases).toBe(1);
      expect(f.dispatch).not.toHaveBeenCalled();
    });
  });

  it("cannot revive or enqueue native handoff after a terminal reconciliation", async () => {
    await executingFixture(async (f) => {
      f.advance(6 * 60 * 1000);
      writeLoopSupervisorWorkOrderState({
        workOrder: f.order,
        supervisorSession: "tmux_proj_loop-supervisor",
        status: "failed",
        resultStatus: "dispatch-failed",
        now: Date.now(),
      });
      const sealed = f.state();
      f.finish();
      await f.waitForEnd();
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.state()).toEqual(sealed);
    });
  });
  it("preserves terminal failure recorded during awaited final-summary recovery", async () => {
    await executingFixture(async (f) => {
      let sealed: ReturnType<typeof f.state> | undefined;
      vi.spyOn(summaryRecovery, "recoverInvalidOutputFromFinalSummaryAsync").mockImplementation(
        async (_order, result) => {
          await Promise.resolve();
          writeLoopSupervisorWorkOrderState({
            workOrder: f.order,
            supervisorSession: "tmux_proj_loop-supervisor",
            status: "failed",
            resultStatus: "dispatch-failed",
            now: Date.now(),
          });
          sealed = f.state();
          return result;
        },
      );
      f.finish();
      await f.waitForEnd();
      expect(sealed).toBeDefined();
      expect(f.state()).toEqual(sealed);
      expect(f.dispatch).toHaveBeenCalledOnce();
    });
  });

  it("does not recover a terminal external failure from a late native summary", async () => {
    await executingFixture(async (f) => {
      writeLoopSupervisorWorkOrderState({
        workOrder: f.order,
        supervisorSession: "tmux_proj_loop-supervisor",
        status: "failed",
        resultStatus: "dispatch-failed",
        now: Date.now(),
      });
      const sealed = f.state();
      writeFileSync(
        f.order.finalSummaryPath!,
        JSON.stringify({
          status: "completed",
          projectId: f.order.projectId,
          actionsTaken: ["late native turn"],
          delegatedTasks: [],
          finalVerification: "passed",
          commits: [],
          followUps: [],
        }),
      );
      await f.reconcile();
      expect(f.state()).toEqual(sealed);
      expect(f.dispatch).not.toHaveBeenCalled();
    });
  });

  it("still expires an unconsumed external dispatch reservation after five minutes", async () => {
    await executingFixture(async (f) => {
      expect(f.state().status).toBe("dispatching");
      f.advance(6 * 60 * 1000);
      await f.reconcile();
      expect(f.state().status).toBe("failed");
      expect(f.dispatch).not.toHaveBeenCalled();
    }, false);
  });

  it.each([
    "missing-lease",
    "foreign-run",
    "foreign-session",
    "foreign-project",
    "foreign-path",
    "missing-reservation",
    "expired-deadline",
  ])("rejects native handoff with %s", async (change) => {
    await executingFixture(async (f) => {
      const leases = readLoopSupervisorWorkerLeaseState().leases;
      if (change === "missing-lease") writeLoopSupervisorWorkerLeaseState({ leases: [] });
      if (change === "foreign-run")
        writeLoopSupervisorWorkerLeaseState({
          leases: leases.map((lease) => ({ ...lease, workOrderId: "another-run" })),
        });
      if (change === "foreign-session")
        writeLoopSupervisorWorkerLeaseState({
          leases: leases.map((lease) => ({ ...lease, workerSession: "another-supervisor" })),
        });
      if (change === "foreign-project")
        writeLoopSupervisorWorkerLeaseState({
          leases: leases.map((lease) => ({ ...lease, projectId: "another-project" })),
        });
      if (change === "foreign-path")
        writeLoopSupervisorWorkerLeaseState({
          leases: leases.map((lease) => ({ ...lease, projectPath: "/another-project" })),
        });
      const foreignLease = ["foreign-session", "foreign-project", "foreign-path"].includes(change)
        ? readLoopSupervisorWorkerLeaseState().leases
        : undefined;
      if (change === "missing-reservation")
        releaseLoopSupervisorSessions(["tmux_proj_loop-supervisor"]);
      if (change === "expired-deadline") f.advance(90 * 60 * 1000 + 1);
      f.finish();
      await f.waitForEnd();
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.state().status).toBe("failed");
      if (foreignLease) expect(readLoopSupervisorWorkerLeaseState().leases).toEqual(foreignLease);
    });
  });

  it("does not claim live external execution after losing the in-memory reservation", async () => {
    await executingFixture(async (f) => {
      releaseLoopSupervisorSessions(["tmux_proj_loop-supervisor"]);
      f.advance(6 * 60 * 1000);
      await f.reconcile();
      expect(f.state().status).toBe("failed");
      expect(hasLoopExecutionQuarantine(f.order.id)).toBe(true);
      expect(f.dispatch).not.toHaveBeenCalled();
    });
  });
  it("hands native review only the remaining original deadline after external execution", async () => {
    await executingFixture(async (f) => {
      f.advance(6 * 60 * 1000);
      f.finish();
      await f.waitForEnd();
      expect(f.dispatch).toHaveBeenCalledOnce();
      const request = f.dispatch.mock.calls[0]?.[0] as { timeoutMs?: number } | undefined;
      const timeoutMs = request?.timeoutMs;
      if (timeoutMs === undefined) throw new Error("missing remaining review budget");
      expect(timeoutMs).toBeLessThanOrEqual(84 * 60 * 1000);
      expect(timeoutMs).toBeGreaterThan(83 * 60 * 1000);
    });
  });

  it.each(["runId", "projectId", "supervisorSession"])(
    "rejects a changed durable %s before claiming external execution",
    async (field) => {
      await executingFixture(async (f) => {
        const statePath = join(dirname(f.order.finalSummaryPath ?? ""), "work-order-state.json");
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        writeFileSync(statePath, JSON.stringify({ ...state, [field]: "foreign" }));
        expect(f.triggerStart).toThrow(/no longer owns/);
        expect(f.dispatch).not.toHaveBeenCalled();
      }, false);
    },
  );
  it("retains a valid twenty-four-hour external owner beyond the legacy twelve-hour orphan partition", async () => {
    await executingFixture(
      async (f) => {
        f.advance(13 * 60 * 60 * 1000);
        await f.reconcile();
        expect(f.state().status).toBe("in-flight");
        expect(f.capacity.read("codex", Date.now()).activeAutonomousLeases).toBe(1);
        expect(readLoopSupervisorWorkerLeaseState().leases).toContainEqual(
          expect.objectContaining({ workOrderId: f.order.id, status: "active" }),
        );
      },
      true,
      24 * 60 * 60 * 1000,
    );
  });

  it.each(["runId", "projectId", "supervisorSession", "deadlineAt"])(
    "does not protect invalid external state %s from actual reconciliation",
    async (field) => {
      await executingFixture(async (f) => {
        const statePath = join(dirname(f.order.finalSummaryPath ?? ""), "work-order-state.json");
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        writeFileSync(
          statePath,
          JSON.stringify({
            ...state,
            [field]: field === "deadlineAt" ? Date.now() - 1 : "foreign",
          }),
        );
        f.advance(6 * 60 * 1000);
        await f.reconcile();
        expect(f.state().status).toBe("failed");
        expect(f.dispatch).not.toHaveBeenCalled();
      });
    },
  );
});
