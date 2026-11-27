import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../src/core/deps.js";
import { buildResourceGuardianRepairPrompt } from "../../src/core/prompts/repair-prompts.js";
import {
  createProductionResourceRepairDispatcher,
  dispatchResourceGuardianRepair,
  dispatchStableResourceRepair,
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
  it.each([
    { pressure: "critical" as const, circuit: "background-closed" as const, stableSince: null },
    { pressure: "healthy" as const, circuit: "open" as const, stableSince: 650_000 },
    { pressure: "healthy" as const, circuit: "open" as const, stableSince: 800_000 },
  ])("avoids reading incident history before stable recovery: %j", async (state) => {
    const listIncidents = vi.fn(() => []);
    const dispatch = vi.fn();
    await dispatchStableResourceRepair({
      now: 700_000,
      ...state,
      store: { listIncidents, writeIncident: vi.fn() },
      dispatch,
    });
    expect(listIncidents).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

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
  function collectorIncident(): ResourceIncident {
    return {
      schemaVersion: 1,
      id: "collector-incident",
      fingerprint: "pressure-unique",
      attribution: "unknown",
      startedAt: 1,
      endedAt: 2,
      pressure: "critical",
      samples: [],
      transitions: [],
      actions: [1, 2].map((at) => ({
        kind: "resource-action",
        at,
        outcome: "failed",
        reason:
          "action preparation failed: Error: invalid tmux pane snapshot: row=1 reason=field-count",
      })),
    };
  }

  it("dispatches ended collector validation failures for diagnosis without claiming process ownership", async () => {
    const incident = collectorIncident();
    const dispatch = vi.fn<Parameters<typeof dispatchStableResourceRepair>[0]["dispatch"]>(
      async () => ({ status: "queued" as const, detail: "queued", workOrderId: "diagnostic-wo" }),
    );
    const writeIncident = vi.fn();
    await dispatchStableResourceRepair({
      now: 700_000,
      pressure: "healthy",
      circuit: "open",
      stableSince: 100_000,
      store: { listIncidents: () => [incident], writeIncident },
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ attribution: "unknown", id: incident.id });
    expect(writeIncident.mock.calls.at(-1)?.[0]).toMatchObject({
      attribution: "unknown",
      repairWorkOrderId: "diagnostic-wo",
    });
    expect(incident.repairWorkOrderId).toBeUndefined();
  });

  it("retries a failed diagnostic after backoff with a fresh stable WorkOrder", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    let incident = collectorIncident();
    const start = vi.fn(async (_prompt: string, context: { runId: string }) => ({
      status: "queued" as const,
      runId: context.runId,
    }));
    const tick = (now: number) =>
      dispatchStableResourceRepair({
        now,
        pressure: "healthy",
        circuit: "open",
        stableSince: 100_000,
        coordinator,
        store: {
          listIncidents: () => [incident],
          writeIncident: (value) => {
            incident = value;
          },
        },
        dispatch: (value) =>
          dispatchResourceGuardianRepair(
            repairInput({
              now,
              coordinator,
              start,
              incident: {
                id: value.id,
                fingerprint: "resource-guardian:pane-snapshot-validation",
                evidence: ["collector failed"],
              },
            }),
          ),
      });
    await tick(700_000);
    const first = coordinator.list()[0];
    if (first?.workOrderId === undefined) throw new Error("missing first diagnostic");
    reconcileResourceGuardianRepairQueue({
      coordinator,
      now: 700_001,
      readRegistry: (() => ({
        terminal: [{ workOrder: { id: first.workOrderId }, state: { status: "failed" } }],
      })) as never,
    });
    const retryAt = coordinator.list()[0]?.nextAttemptAt ?? 0;
    await tick(retryAt - 1);
    expect(start).toHaveBeenCalledOnce();
    await tick(retryAt);
    expect(start).toHaveBeenCalledTimes(2);
    expect(coordinator.list()[0]?.workOrderId).not.toBe(first.workOrderId);
    expect(coordinator.list()[0]).toMatchObject({ status: "running", attempt: 1 });
  });

  it("does not turn generic preparation failures or active incidents into diagnostic authority", () => {
    const incident = collectorIncident();
    const { endedAt: _, ...active } = incident;
    for (const candidate of [
      active,
      {
        ...incident,
        actions: incident.actions.map((action) => ({
          ...action,
          reason: "action preparation failed: Error: unknown process",
        })),
      },
    ]) {
      expect(selectResourceRepairCandidate([candidate])).toBeUndefined();
    }
  });

  it.each(["reopen", "exhausted", "original", "missing-provenance", "older", "live", "fixed"])(
    "reconsiders only a false collector link within its original safety gates: %s",
    async (scenario) => {
      const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
      const queued = coordinator.enqueue({
        projectId: "bot",
        projectPath: "/repo",
        source: "resource-guardian",
        taskFamily: "resource-guardian-stable-recovery",
        fingerprint: "resource-guardian:pane-snapshot-validation",
        taskId: "older-incident",
        now: 1,
      });
      coordinator.claimIds([queued.id], { now: 1, leaseId: "old", limit: 1 });
      coordinator.markRunning(queued.id, "old", 1);
      coordinator.attachWorkOrder(queued.id, "old-blocked-wo", 2);
      coordinator.releaseForRetry(queued.id, 2);
      coordinator.releaseForRetry(queued.id, 2);
      if (scenario === "exhausted") coordinator.releaseForRetry(queued.id, 2);
      coordinator.markTerminal(queued.id, "blocked", 3);
      const incident = {
        ...collectorIncident(),
        startedAt: 4,
        endedAt: 6,
        repairWorkOrderId: "old-blocked-wo",
      };
      incident.actions.push({
        kind: "resource-action",
        phase: "repair-dispatch",
        at: 10,
        outcome: "recorded",
        reason: "repair work order recovered from durable queue",
      });
      if (scenario === "original") coordinator.linkTaskIds(queued.id, [incident.id], 3);
      if (scenario === "missing-provenance") incident.actions.pop();
      if (scenario === "older") incident.endedAt = 2;
      if (scenario === "fixed") coordinator.markTerminal(queued.id, "fixed", 3);
      if (scenario === "live") {
        coordinator.releaseToQueue(queued.id, 3);
        coordinator.claimIds([queued.id], { now: 3, leaseId: "active", limit: 1 });
        coordinator.markRunning(queued.id, "active", 3);
      }
      const dispatch = vi.fn(async () => ({
        status: "queued" as const,
        detail: "queued",
        workOrderId: "fresh-wo",
      }));
      const writeIncident = vi.fn();
      await dispatchStableResourceRepair({
        now: 700_000,
        pressure: "healthy",
        circuit: "open",
        stableSince: 100_000,
        store: { listIncidents: () => [incident], writeIncident },
        coordinator,
        dispatch,
      });
      if (scenario === "reopen") {
        expect(dispatch).toHaveBeenCalledOnce();
        expect(writeIncident.mock.calls.at(-1)?.[0]).toMatchObject({
          repairWorkOrderId: "fresh-wo",
          attribution: "unknown",
        });
      } else {
        expect(dispatch).not.toHaveBeenCalled();
        expect(writeIncident).not.toHaveBeenCalled();
      }
      expect(incident.repairWorkOrderId).toBe("old-blocked-wo");
      expect(coordinator.list()[0]?.attempt).toBe(scenario === "exhausted" ? 3 : 2);
    },
  );

  it("keeps collector diagnosis inside a shared retry budget across pressure incidents", async () => {
    const incident = collectorIncident();
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const queued = coordinator.enqueue({
      projectId: "bot",
      projectPath: "/repo",
      source: "resource-guardian",
      taskFamily: "resource-guardian-stable-recovery",
      fingerprint: "resource-guardian:pane-snapshot-validation",
      taskId: "older-pressure-incident",
      now: 1,
    });
    for (let n = 0; n < 3; n++) coordinator.releaseForRetry(queued.id, 10 + n);
    const dispatch = vi.fn();
    await dispatchStableResourceRepair({
      now: 700_000,
      pressure: "healthy",
      circuit: "open",
      stableSince: 100_000,
      store: { listIncidents: () => [incident], writeIncident: vi.fn() },
      coordinator,
      dispatch,
    });
    expect(selectResourceRepairCandidate([incident])?.id).toBe(incident.id);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]?.attempt).toBe(3);
  });

  it("states diagnostic-only scope in the collector recovery prompt", () => {
    const prompt = buildResourceGuardianRepairPrompt({
      repoPath: "/repo",
      repairBranch: "repair/resource",
      diagnosticOnly: true,
      incident: {
        id: "incident",
        fingerprint: "resource-guardian:pane-snapshot-validation",
        evidence: [],
      },
    });
    expect(prompt).toContain("Collector diagnosis only");
    expect(prompt).toContain("never terminate processes");
    expect(prompt).toContain("unknown process ownership remains unknown");
  });

  it("uses the diagnostic fingerprint and scope at the production delegation boundary", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const requirements: string[] = [];
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
        start: (async (_deps: unknown, input: { requirement: string }) => {
          requirements.push(input.requirement);
          return { status: "queued", runId: "diagnostic-work-order" };
        }) as never,
      },
    );
    const incident = collectorIncident();
    const result = await dispatcher(incident, 700_000);
    expect(result.status).toBe("queued");
    expect(coordinator.list()[0]).toMatchObject({
      fingerprint: "resource-guardian:pane-snapshot-validation",
      workOrderId: "diagnostic-work-order",
    });
    expect(requirements[0]).toContain("Collector diagnosis only");
    expect(requirements[0]).toContain("row=1 reason=field-count");
    expect(incident.attribution).toBe("unknown");
  });

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
  it.each(["leased", "running"])("reads the registry once for an attached %s repair", (status) => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const record = coordinator.enqueue({
      projectId: "bot",
      projectPath: "/synthetic",
      source: "resource-guardian",
      taskFamily: "repair",
      fingerprint: "active-probe",
      taskId: "incident",
      now: 1,
    });
    coordinator.claimIds([record.id], { now: 1, leaseId: "lease", limit: 1 });
    coordinator.markRunning(record.id, "lease", 1);
    coordinator.attachWorkOrder(record.id, "wo-1", 1);
    if (status === "leased") {
      coordinator.releaseToQueue(record.id, 1);
      coordinator.claimIds([record.id], { now: 1, leaseId: "retry-lease", limit: 1 });
    }
    const readRegistry = vi.fn(() => ({ terminal: [] }));

    reconcileResourceGuardianRepairQueue({ coordinator, now: 2, readRegistry });

    expect(readRegistry).toHaveBeenCalledTimes(1);
    expect(coordinator.list()[0]?.status).toBe(status);
  });

  it("does not read historical WorkOrders when the repair queue is empty", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const readRegistry = vi.fn(() => ({ terminal: [] }));

    reconcileResourceGuardianRepairQueue({ coordinator, now: 2, readRegistry });

    expect(readRegistry).not.toHaveBeenCalled();
  });

  it.each(["pending", "unattached", "terminal", "other-source"])(
    "does not read historical WorkOrders for a %s repair",
    (scenario) => {
      const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
      const record = coordinator.enqueue({
        projectId: "bot",
        projectPath: "/synthetic",
        source: scenario === "other-source" ? "runtime-guardian" : "resource-guardian",
        taskFamily: "repair",
        fingerprint: "bounded-probe",
        taskId: "incident",
        now: 1,
      });
      if (scenario !== "pending") {
        coordinator.claimIds([record.id], { now: 1, leaseId: "lease", limit: 1 });
        coordinator.markRunning(record.id, "lease", 1);
      }
      if (scenario !== "unattached") coordinator.attachWorkOrder(record.id, "wo-1", 1);
      if (scenario === "terminal") coordinator.markTerminal(record.id, "fixed", 1);
      const readRegistry = vi.fn(() => ({ terminal: [] }));

      reconcileResourceGuardianRepairQueue({ coordinator, now: 2, readRegistry });

      expect(readRegistry).not.toHaveBeenCalled();
    },
  );

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

  it("spends one retry for a terminal failed diagnostic and never settles it twice", () => {
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
    coordinator.attachWorkOrder(record.id, "failed-diagnostic", 1);
    const readRegistry = (() => ({
      terminal: [{ workOrder: { id: "failed-diagnostic" }, state: { status: "failed" } }],
    })) as never;
    reconcileResourceGuardianRepairQueue({ coordinator, now: 2, readRegistry });
    reconcileResourceGuardianRepairQueue({ coordinator, now: 3, readRegistry });
    expect(coordinator.list()[0]).toMatchObject({ status: "retry-wait", attempt: 1 });
    expect(coordinator.list()[0]?.workOrderId).toBeUndefined();
  });

  it("reopens a retryable terminal Resource Guardian record instead of duplicating the fingerprint", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const first = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo",
      source: "resource-guardian",
      taskFamily: "resource-guardian-stable-recovery",
      fingerprint: "resource-pressure:1",
      taskId: "incident-1",
      summary: "cleanup still needed",
      now: 1_000,
    });
    coordinator.markTerminal(first.id, "blocked", 2_000);

    const second = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo",
      source: "resource-guardian",
      taskFamily: "resource-guardian-stable-recovery",
      fingerprint: "resource-pressure:1",
      taskId: "incident-2",
      summary: "same fingerprint observed again",
      now: 3_000,
    });

    expect(second.id).toBe(first.id);
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]).toMatchObject({
      status: "pending",
      linkedTaskIds: ["incident-1", "incident-2"],
      summaries: ["cleanup still needed", "same fingerprint observed again"],
      updatedAt: 3_000,
    });
  });

  it("does not resurrect closed Resource Guardian terminal outcomes", () => {
    for (const terminalStatus of [
      "fixed",
      "not-reproducible",
      "superseded",
      "dead-letter",
    ] as const) {
      const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
      const first = coordinator.enqueue({
        projectId: "tmux-claude-bot",
        projectPath: "/repo",
        source: "resource-guardian",
        taskFamily: "resource-guardian-stable-recovery",
        fingerprint: "resource-pressure:closed",
        taskId: "incident-1",
        now: 1_000,
      });
      coordinator.markTerminal(first.id, terminalStatus, 2_000);

      const second = coordinator.enqueue({
        projectId: "tmux-claude-bot",
        projectPath: "/repo",
        source: "resource-guardian",
        taskFamily: "resource-guardian-stable-recovery",
        fingerprint: "resource-pressure:closed",
        taskId: "incident-2",
        now: 3_000,
      });

      expect(second.id).not.toBe(first.id);
      expect(coordinator.list()).toEqual([
        expect.objectContaining({
          id: first.id,
          status: terminalStatus,
          linkedTaskIds: ["incident-1"],
        }),
        expect.objectContaining({
          id: second.id,
          status: "pending",
          linkedTaskIds: ["incident-2"],
        }),
      ]);
    }
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
  it("gives a new incident its own stable WorkOrder without reusing a terminal diagnostic", async () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const start = vi.fn(async (_prompt: string, context: { runId: string }) => ({
      status: "queued" as const,
      runId: context.runId,
    }));
    const first = await dispatchResourceGuardianRepair(
      repairInput({ coordinator, now: 100, start }),
    );
    if (first.queueId === undefined) throw new Error("missing original queue");
    coordinator.markTerminal(first.queueId, "blocked", 101);
    const next = await dispatchResourceGuardianRepair(
      repairInput({
        coordinator,
        now: 102,
        start,
        incident: { id: "later-incident", fingerprint: "fingerprint-1", evidence: ["new failure"] },
      }),
    );
    expect(next.queueId).toBe(first.queueId);
    expect(next.workOrderId).not.toBe(first.workOrderId);
  });

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
