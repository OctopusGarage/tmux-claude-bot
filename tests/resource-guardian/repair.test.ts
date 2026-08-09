import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../src/core/deps.js";
import {
  createProductionResourceRepairDispatcher,
  dispatchResourceGuardianRepair,
  reconcileResourceGuardianRepairQueue,
  resourceRepairEligibility,
  resourceRepairQueueState,
  selectResourceRepairCandidate,
} from "../../src/core/resource-guardian/repair.js";
import type { ResourceIncident } from "../../src/core/resource-guardian/types.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";

describe("resourceRepairEligibility", () => {
  it("allows only a bot-owned incident with durable unresolved cleanup evidence after ten healthy minutes", () => {
    expect(
      resourceRepairEligibility({
        now: 700_000,
        pressure: "healthy",
        circuit: "open",
        stableSince: 100_000,
        incident: { id: "incident-1", fingerprint: "bot-load", attribution: "bot-owned" },
        hasRepairNeededEvidence: true,
        hasActiveFingerprintRepair: false,
        hasActiveResourceRepair: false,
        cooldownActive: false,
        retryExhausted: false,
      }),
    ).toEqual({ eligible: true });
  });

  it("fails closed for unstable, non-bot, duplicate, concurrent, cooldown, or exhausted repair", () => {
    const base = {
      now: 700_000,
      pressure: "healthy" as const,
      circuit: "open" as const,
      stableSince: 100_000,
      incident: { id: "incident-1", fingerprint: "bot-load", attribution: "bot-owned" as const },
      hasRepairNeededEvidence: true,
      hasActiveFingerprintRepair: false,
      hasActiveResourceRepair: false,
      cooldownActive: false,
      retryExhausted: false,
    };
    for (const input of [
      { ...base, stableSince: 100_001 },
      { ...base, pressure: "critical" as const },
      { ...base, circuit: "background-closed" as const },
      { ...base, incident: { ...base.incident, attribution: "external" as const } },
      { ...base, hasRepairNeededEvidence: false },
      { ...base, hasActiveFingerprintRepair: true },
      { ...base, hasActiveResourceRepair: true },
      { ...base, cooldownActive: true },
      { ...base, retryExhausted: true },
      { ...base, now: 99_999 },
    ]) {
      expect(resourceRepairEligibility(input).eligible).toBe(false);
    }
  });
});

describe("selectResourceRepairCandidate", () => {
  it("selects the most recent bot-owned ended incident only after durable failed cleanup", () => {
    const incident = (
      id: string,
      endedAt: number,
      attribution: ResourceIncident["attribution"],
    ): ResourceIncident => ({
      schemaVersion: 1,
      id,
      fingerprint: `fp-${id}`,
      attribution,
      startedAt: endedAt - 10,
      endedAt,
      pressure: "critical",
      samples: [],
      transitions: [],
      actions: [
        {
          kind: "resource-action",
          phase: "deterministic-cleanup",
          at: endedAt - 1,
          outcome: "failed",
          reason: "cleanup did not fully resolve the incident",
        },
      ],
    });
    const selected = selectResourceRepairCandidate([
      incident("external", 30, "external"),
      { ...incident("not-clean", 40, "bot-owned"), actions: [] },
      {
        ...incident("closed", 45, "bot-owned"),
        actions: [
          {
            kind: "resource-action",
            phase: "deterministic-cleanup",
            at: 44,
            outcome: "recorded",
            reason: "cleanup completed",
          },
        ],
      },
      incident("older", 50, "bot-owned"),
      incident("newer", 60, "bot-owned"),
    ]);

    expect(selected?.id).toBe("newer");
  });

  it("fails closed for legacy cleanup evidence without an explicit deterministic phase", () => {
    const legacy: ResourceIncident = {
      schemaVersion: 1,
      id: "legacy",
      fingerprint: "legacy-fingerprint",
      attribution: "bot-owned",
      startedAt: 1,
      endedAt: 2,
      pressure: "critical",
      samples: [],
      transitions: [],
      actions: [
        {
          kind: "resource-action",
          at: 1,
          outcome: "recorded",
          reason: "ambiguous historical action",
        },
      ],
    };

    expect(selectResourceRepairCandidate([legacy])).toBeUndefined();
  });
});

describe("resourceRepairQueueState", () => {
  it("projects durable retry cooldown and exhaustion before eligibility", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const record = coordinator.enqueue({
      projectId: "bot",
      projectPath: "/bot",
      source: "resource-guardian",
      taskFamily: "resource-guardian-stable-recovery",
      fingerprint: "fp",
      taskId: "incident",
      now: 1,
    });
    coordinator.releaseForRetry(record.id, 10);
    expect(resourceRepairQueueState(coordinator, "fp", 11)).toMatchObject({
      cooldownActive: true,
      retryExhausted: false,
    });
    coordinator.releaseForRetry(record.id, 100_000);
    coordinator.releaseForRetry(record.id, 200_000);
    expect(resourceRepairQueueState(coordinator, "fp", 1_000_000)).toMatchObject({
      retryExhausted: true,
    });
  });

  it("blocks any leased or running global repair but not terminal work", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const running = coordinator.enqueue({
      projectId: "other",
      projectPath: "/other",
      source: "runtime-guardian",
      taskFamily: "runtime-repair",
      fingerprint: "other-fingerprint",
      taskId: "other-task",
      now: 1,
    });
    coordinator.claimIds([running.id], { now: 1, leaseId: "other", limit: 1 });
    coordinator.markRunning(running.id, "other", 1);
    expect(resourceRepairQueueState(coordinator, "fp", 2).hasActiveResourceRepair).toBe(true);
    coordinator.markTerminal(running.id, "fixed", 3);
    expect(resourceRepairQueueState(coordinator, "fp", 4).hasActiveResourceRepair).toBe(false);
  });

  it("settles an attached terminal WorkOrder so it cannot retain global repair ownership", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const record = coordinator.enqueue({
      projectId: "bot",
      projectPath: "/bot",
      source: "resource-guardian",
      taskFamily: "resource-guardian-stable-recovery",
      fingerprint: "fp",
      taskId: "incident",
      now: 1,
    });
    coordinator.claimIds([record.id], { now: 1, leaseId: "lease", limit: 1 });
    coordinator.markRunning(record.id, "lease", 1);
    coordinator.attachWorkOrder(record.id, "resource-repair-repair-1-1", 1);

    reconcileResourceGuardianRepairQueue({
      coordinator,
      now: 2,
      readRegistry: (() =>
        ({
          terminal: [
            {
              workOrder: { id: "resource-repair-repair-1-1" },
              state: { status: "completed" },
            },
          ],
        }) as never) as never,
    });

    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });
  });
});

function repairInput(
  overrides: Partial<Parameters<typeof dispatchResourceGuardianRepair>[0]> = {},
) {
  const coordinator =
    overrides.coordinator ?? new RepairCoordinator(new InMemoryRepairQueueStore());
  return {
    now: 100_000,
    repoPath: "/repo",
    repairBranch: "repair/resource",
    incident: { id: "incident-1", fingerprint: "fingerprint-1", evidence: ["cleanup completed"] },
    coordinator,
    gitTopLevel: async () => "/repo",
    start: async () => ({ status: "queued" as const, runId: "work-order-1" }),
    prompt: "repair",
    ...overrides,
  };
}

describe("dispatchResourceGuardianRepair", () => {
  it("blocks exact repository dispatch on a missing or mismatched git toplevel", async () => {
    for (const gitTopLevel of [async () => null, async () => "/other-repo"]) {
      const startCalls: string[] = [];
      const result = await dispatchResourceGuardianRepair(
        repairInput({
          gitTopLevel,
          start: async () => {
            startCalls.push("start");
            return { status: "queued" };
          },
        }),
      );

      expect(result.status).toBe("blocked");
      expect(startCalls).toEqual([]);
    }
  });

  it("keeps a blocked repair retryable until its due time, then retries the same queue record", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    let starts = 0;
    const first = await dispatchResourceGuardianRepair(
      repairInput({
        coordinator,
        now: 100,
        start: async () => {
          starts += 1;
          return { status: "blocked" as const };
        },
      }),
    );
    const retry = coordinator.list()[0];
    expect(first.status).toBe("blocked");
    expect(retry).toMatchObject({ status: "retry-wait", attempt: 1, nextAttemptAt: 30_100 });
    if (retry === undefined) throw new Error("expected retry queue record");

    const early = await dispatchResourceGuardianRepair(repairInput({ coordinator, now: 30_099 }));
    const due = await dispatchResourceGuardianRepair(
      repairInput({
        coordinator,
        now: 30_100,
        start: async () => {
          starts += 1;
          return { status: "queued", runId: "work-order-2" };
        },
      }),
    );

    expect(early.status).toBe("blocked");
    expect(due).toMatchObject({ status: "queued", queueId: retry.id });
    expect(starts).toBe(2);
  });

  it("blocks exhausted retries and leaves intent failures, blocked starts, and thrown starts retryable", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    for (const failure of [
      {
        persistIntent: async () => {
          throw new Error("disk full");
        },
      },
      { start: async () => ({ status: "blocked" as const }) },
      {
        start: async () => {
          throw new Error("delegate exploded");
        },
      },
    ]) {
      const local = new RepairCoordinator(new InMemoryRepairQueueStore());
      const result = await dispatchResourceGuardianRepair(
        repairInput({ coordinator: local, ...failure }),
      );
      expect(result.status).toBe("blocked");
      expect(local.list()[0]).toMatchObject({ status: "retry-wait", attempt: 1 });
    }

    const record = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo",
      source: "resource-guardian",
      taskFamily: "resource-guardian-stable-recovery",
      fingerprint: "fingerprint-1",
      taskId: "incident-1",
      now: 1,
    });
    coordinator.releaseForRetry(record.id, 1);
    coordinator.releaseForRetry(record.id, 100_000);
    coordinator.releaseForRetry(record.id, 200_000);
    const exhausted = await dispatchResourceGuardianRepair(
      repairInput({ coordinator, now: 1_000_000 }),
    );
    expect(exhausted.status).toBe("blocked");
  });

  it("attaches the delegated work order to the durable queue record", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const result = await dispatchResourceGuardianRepair(repairInput({ coordinator }));

    expect(result).toMatchObject({ status: "queued", workOrderId: "work-order-1" });
    expect(coordinator.list()[0]).toMatchObject({ status: "running", workOrderId: "work-order-1" });
  });

  it("reuses a stable delegated work order after attach failure without starting a second worker", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const durableRuns = new Set<string>();
    let newWorkers = 0;
    const attach = vi.spyOn(coordinator, "attachWorkOrder").mockReturnValueOnce(undefined);
    const start = async (_prompt: string, context: { runId: string }) => {
      if (!durableRuns.has(context.runId)) {
        durableRuns.add(context.runId);
        newWorkers += 1;
      }
      return { status: "queued" as const, runId: context.runId };
    };

    const first = await dispatchResourceGuardianRepair(
      repairInput({ coordinator, now: 100, start }),
    );
    const retry = coordinator.list()[0];
    if (retry === undefined) throw new Error("expected retry record");
    const second = await dispatchResourceGuardianRepair(
      repairInput({ coordinator, now: retry.nextAttemptAt, start }),
    );

    expect(first.status).toBe("blocked");
    expect(second).toMatchObject({ status: "queued", workOrderId: `resource-repair-${retry.id}` });
    expect(newWorkers).toBe(1);
    expect(coordinator.list()[0]).toMatchObject({
      status: "running",
      workOrderId: `resource-repair-${retry.id}`,
    });
    attach.mockRestore();
  });

  it("returns an attach exception to retry-wait without retaining a running queue record", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const attach = vi.spyOn(coordinator, "attachWorkOrder").mockImplementationOnce(() => {
      throw new Error("queue store unavailable");
    });

    const result = await dispatchResourceGuardianRepair(repairInput({ coordinator }));

    expect(result.status).toBe("blocked");
    expect(coordinator.list()[0]).toMatchObject({ status: "retry-wait", attempt: 1 });
    attach.mockRestore();
  });

  it("returns a queued result without a durable work order id to retry-wait", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const result = await dispatchResourceGuardianRepair(
      repairInput({ coordinator, start: async () => ({ status: "queued" }) }),
    );

    expect(result.status).toBe("blocked");
    expect(coordinator.list()[0]).toMatchObject({ status: "retry-wait", attempt: 1 });
  });

  it("blocks dispatch while another source owns a running global repair", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const running = coordinator.enqueue({
      projectId: "other",
      projectPath: "/other",
      source: "runtime-guardian",
      taskFamily: "runtime-repair",
      fingerprint: "other-fingerprint",
      taskId: "other-task",
      now: 1,
    });
    coordinator.claimIds([running.id], { now: 1, leaseId: "other", limit: 1 });
    coordinator.markRunning(running.id, "other", 1);

    const result = await dispatchResourceGuardianRepair(repairInput({ coordinator }));
    expect(result.status).toBe("duplicate");
    expect(coordinator.list()).toHaveLength(1);
  });
});

describe("createProductionResourceRepairDispatcher", () => {
  it("enforces the configured repository boundary before starting a production repair", async () => {
    for (const [actual, expectedStarts] of [
      ["/repo", 1],
      ["/other-repo", 0],
      [null, 0],
    ] as const) {
      let starts = 0;
      let sessions = 0;
      const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
      const dispatcher = createProductionResourceRepairDispatcher(
        {
          config: {
            projectSessionPrefix: "tmux_proj_",
            loopEngineering: { supervisor: { enabled: true } },
            runtimeGuardian: {
              repoPath: "/repo",
              repairBranch: "repair/resource",
              worktreeIsolation: "isolated",
            },
          },
        } as unknown as HandlerDeps,
        {
          coordinator,
          gitTopLevel: async () => actual,
          setSessionPath: (() => {
            sessions += 1;
          }) as never,
          start: (async () => {
            starts += 1;
            return {
              status: "queued",
              runId: "production-work-order",
              projectId: "tmux-claude-bot",
              supervisorSession: "tmux_proj_repo",
              reportDir: null,
            };
          }) as never,
        },
      );
      const result = await dispatcher(
        {
          schemaVersion: 1,
          id: "production-incident",
          fingerprint: "production-fingerprint",
          attribution: "bot-owned",
          startedAt: 1,
          endedAt: 2,
          pressure: "critical",
          samples: [],
          transitions: [],
          actions: [],
        },
        1_000,
      );

      expect(result.status).toBe(expectedStarts === 1 ? "queued" : "blocked");
      expect(starts).toBe(expectedStarts);
      expect(sessions).toBe(expectedStarts);
      expect(coordinator.list()).toHaveLength(expectedStarts);
    }
  });

  it("returns production intent and delegated-start failures to the durable retry queue", async () => {
    for (const start of [
      async () => ({ status: "blocked" as const, reason: "busy", showQueue: false }),
      async () => {
        throw new Error("delegate failed");
      },
    ]) {
      const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
      const dispatcher = createProductionResourceRepairDispatcher(
        {
          config: {
            projectSessionPrefix: "tmux_proj_",
            loopEngineering: { supervisor: { enabled: true } },
            runtimeGuardian: {
              repoPath: "/repo",
              repairBranch: "repair/resource",
              worktreeIsolation: "isolated",
            },
          },
        } as unknown as HandlerDeps,
        {
          coordinator,
          gitTopLevel: async () => "/repo",
          setSessionPath: (() => undefined) as never,
          start: start as never,
        },
      );
      let persisted = 0;
      const result = await dispatcher(
        {
          schemaVersion: 1,
          id: "production-incident",
          fingerprint: "production-fingerprint",
          attribution: "bot-owned",
          startedAt: 1,
          endedAt: 2,
          pressure: "critical",
          samples: [],
          transitions: [],
          actions: [],
        },
        1_000,
        async () => {
          persisted += 1;
        },
      );
      expect(result.status).toBe("blocked");
      expect(persisted).toBe(1);
      expect(coordinator.list()[0]).toMatchObject({ status: "retry-wait", attempt: 1 });
    }

    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    let starts = 0;
    const dispatcher = createProductionResourceRepairDispatcher(
      {
        config: {
          projectSessionPrefix: "tmux_proj_",
          loopEngineering: { supervisor: { enabled: true } },
          runtimeGuardian: {
            repoPath: "/repo",
            repairBranch: "repair/resource",
            worktreeIsolation: "isolated",
          },
        },
      } as unknown as HandlerDeps,
      {
        coordinator,
        gitTopLevel: async () => "/repo",
        setSessionPath: (() => undefined) as never,
        start: (async () => {
          starts += 1;
          return {
            status: "queued",
            runId: "unexpected",
            projectId: "tmux-claude-bot",
            supervisorSession: "tmux_proj_repo",
            reportDir: null,
          };
        }) as never,
      },
    );
    const intentFailure = await dispatcher(
      {
        schemaVersion: 1,
        id: "production-incident",
        fingerprint: "production-fingerprint",
        attribution: "bot-owned",
        startedAt: 1,
        endedAt: 2,
        pressure: "critical",
        samples: [],
        transitions: [],
        actions: [],
      },
      1_000,
      async () => {
        throw new Error("incident store write failed");
      },
    );
    expect(intentFailure.status).toBe("blocked");
    expect(starts).toBe(0);
    expect(coordinator.list()[0]).toMatchObject({ status: "retry-wait", attempt: 1 });
  });

  it("uses the active delegated surface with the resource-repair trigger and no force", async () => {
    const calls: unknown[] = [];
    const dispatcher = createProductionResourceRepairDispatcher(
      {
        config: {
          projectSessionPrefix: "tmux_proj_",
          loopEngineering: { supervisor: { enabled: true } },
          runtimeGuardian: {
            repoPath: "/repo",
            repairBranch: "repair/resource",
            worktreeIsolation: "isolated",
          },
        },
      } as unknown as HandlerDeps,
      {
        coordinator: new RepairCoordinator(new InMemoryRepairQueueStore()),
        gitTopLevel: async () => "/repo",
        setSessionPath: (() => undefined) as never,
        start: (async (_deps: HandlerDeps, input: unknown) => {
          calls.push(input);
          return {
            status: "queued",
            runId: "production-work-order",
            projectId: "tmux-claude-bot",
            supervisorSession: "tmux_proj_repo",
            reportDir: null,
          };
        }) as never,
      },
    );
    const incident: ResourceIncident = {
      schemaVersion: 1,
      id: "production-incident",
      fingerprint: "production-fingerprint",
      attribution: "bot-owned",
      startedAt: 1,
      endedAt: 2,
      pressure: "critical",
      samples: [],
      transitions: [],
      actions: [],
    };

    const result = await dispatcher(incident, 1_000);

    expect(result).toMatchObject({ status: "queued", workOrderId: "production-work-order" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      resourceTrigger: "resource-repair",
      worktreeIsolation: "isolated",
      trustedRunId: expect.stringMatching(/^resource-repair-repair-/),
    });
    expect(calls[0]).not.toHaveProperty("resourceForce");
  });
});
