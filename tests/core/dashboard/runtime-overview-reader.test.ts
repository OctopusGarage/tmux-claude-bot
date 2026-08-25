import { describe, expect, it } from "vitest";
import {
  type RuntimeOverviewReaders,
  readRuntimeOverview,
} from "../../../src/core/dashboard/runtime-overview-reader.js";

function readers(overrides: Partial<RuntimeOverviewReaders> = {}): RuntimeOverviewReaders {
  return {
    automation: () => [
      {
        id: "loop",
        label: "Loop Engineering",
        enabled: true,
        configured: true,
        tickMs: 300_000,
      },
    ],
    workOrders: () => ({ unfinished: [], terminal: [], abandoned: [], staleDispatching: [] }),
    repositoryReviews: () => [],
    dailyAudit: () => ({ enabled: true, lastFiredAt: 100 }),
    runtimeGuardian: () => ({ enabled: true, findings: [] }),
    resourceGuardian: () => ({
      enabled: true,
      mode: "protect",
      profile: "balanced",
      pressure: "healthy",
      circuit: "open",
      changedAt: 100,
      degraded: false,
      samplingDegraded: false,
    }),
    agentCapacity: () => ({
      enabled: true,
      agent: "codex",
      authentication: "subscription",
      state: "available",
      observedAt: 100,
      retryAt: 200,
      activeAutonomousLeases: 0,
      plannedOccurrences: 1,
      nextOccurrenceAt: 500,
      ownerLastActivityAt: null,
    }),
    power: () => ({
      mode: "scheduled",
      phase: "service",
      powerSource: "ac",
      scheduleStatus: "verified",
      degraded: false,
    }),
    operator: () => ({
      session: { state: "ready" },
      skills: { installed: 2, expected: 2, state: "ready" },
      mcpProfiles: { installed: 2, expected: 2, state: "ready", profiles: [] },
      promptLibrary: { state: "disabled" },
      optionalProjectMcpCount: 0,
    }),
    ...overrides,
  };
}

describe("Runtime Overview reader", () => {
  it("contains one failed domain while preserving the other authoritative reads", async () => {
    const overview = await readRuntimeOverview({
      now: 1_000,
      sessions: [],
      readers: readers({
        runtimeGuardian: () => {
          throw new Error("token=secret /Users/private source command");
        },
      }),
    });

    expect(overview.health.status).toBe("degraded");
    expect(overview.degradedDomains).toEqual(["runtime-guardian"]);
    expect(overview.automation).toHaveLength(1);
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({ id: "power", status: "healthy", errorKind: null }),
    );
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({
        id: "runtime-guardian",
        status: "degraded",
        errorKind: "read-failed",
      }),
    );
    expect(JSON.stringify(overview)).not.toContain("token=secret");
    expect(JSON.stringify(overview)).not.toContain("/Users/private");
  });

  it("projects active work, failures, guardian pressure, and interface readiness", async () => {
    const overview = await readRuntimeOverview({
      now: 2_000,
      sessions: [
        {
          session: "tcb-alpha",
          label: "alpha",
          busy: true,
          running: true,
          operator: false,
          taskStartedAt: 1_800,
        },
      ],
      readers: readers({
        workOrders: () => ({
          unfinished: [
            {
              id: "wo-running",
              projectId: "alpha",
              projectName: "Alpha",
              taskKind: "architecture",
              status: "in-flight",
              scheduledAt: 1_000,
              updatedAt: 1_900,
            },
          ],
          terminal: [
            {
              id: "wo-failed",
              projectId: "beta",
              projectName: "Beta",
              taskKind: "test-coverage",
              status: "failed",
              scheduledAt: 500,
              updatedAt: 1_700,
            },
          ],
          abandoned: [],
          staleDispatching: [],
        }),
        resourceGuardian: () => ({
          enabled: true,
          mode: "protect",
          profile: "balanced",
          pressure: "critical",
          circuit: "background-closed",
          changedAt: 1_950,
          degraded: false,
          samplingDegraded: false,
        }),
        operator: () => ({
          session: { state: "ready" },
          skills: { installed: 1, expected: 2, state: "attention" },
          mcpProfiles: { installed: 2, expected: 2, state: "ready", profiles: [] },
          promptLibrary: { state: "disabled" },
          optionalProjectMcpCount: 0,
        }),
      }),
    });

    expect(overview.activeWork.items.map((item) => item.id)).toEqual([
      "session:tcb-alpha",
      "work-order:wo-running",
    ]);
    expect(overview.recentOutcomes.items).toContainEqual(
      expect.objectContaining({ id: "work-order:wo-failed", status: "failed" }),
    );
    expect(overview.attention.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "resource-guardian:circuit",
        "work-order:wo-failed",
        "operator:skills",
      ]),
    );
    expect(overview.health.status).toBe("attention");
  });

  it("points Runtime Guardian findings at the bounded findings drilldown", async () => {
    const overview = await readRuntimeOverview({
      now: 2_000,
      sessions: [],
      readers: readers({
        runtimeGuardian: () => ({
          enabled: true,
          findings: [
            {
              id: "terminal-invalid-output:run-1",
              projectId: "alpha",
              kind: "terminal-invalid-output",
              severity: "high",
              observedAt: 1_900,
            },
          ],
        }),
      }),
    });

    expect(overview.attention.items).toContainEqual(
      expect.objectContaining({
        id: "runtime-guardian:terminal-invalid-output:run-1",
        nextAction: "tcb runtime-guardian findings --project alpha --limit 20",
      }),
    );
  });

  it("surfaces exhausted agent capacity as operator attention", async () => {
    const overview = await readRuntimeOverview({
      now: 2_000,
      sessions: [],
      readers: readers({
        agentCapacity: () => ({
          enabled: true,
          agent: "codex",
          authentication: "subscription",
          state: "exhausted",
          observedAt: 1_900,
          retryAt: 3_000,
          activeAutonomousLeases: 0,
          plannedOccurrences: 2,
          nextOccurrenceAt: 3_000,
          ownerLastActivityAt: 1_800,
        }),
      }),
    });

    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({ id: "agent-capacity", status: "attention" }),
    );
    expect(overview.attention.items).toContainEqual(
      expect.objectContaining({
        id: "agent-capacity:codex",
        presentation: { kind: "agent-capacity", agent: "codex", state: "exhausted" },
      }),
    );
  });

  it("distinguishes automatic repository review recovery from real manual and exhausted work", async () => {
    const overview = await readRuntimeOverview({
      now: 2_000,
      sessions: [],
      readers: readers({
        repositoryReviews: () => [
          {
            id: "retry",
            repositoryId: "fluent-frame-all-prs",
            status: "retry-wait",
            updatedAt: 1_900,
            nextAttemptAt: 3_000,
            retryEpoch: 1,
          },
          {
            id: "manual",
            repositoryId: "product-all-prs",
            status: "manual-review",
            updatedAt: 1_800,
            nextAttemptAt: 1_800,
            retryEpoch: 0,
          },
          {
            id: "dead",
            repositoryId: "broken-all-prs",
            status: "dead-letter",
            updatedAt: 1_700,
            nextAttemptAt: 1_700,
            retryEpoch: 0,
          },
        ],
      }),
    });

    expect(overview.attention.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "repository-review:retry",
          severity: "info",
          summary: expect.stringContaining("automatic retry"),
        }),
        expect.objectContaining({
          id: "repository-review:manual",
          severity: "warning",
          summary: expect.stringContaining("human boundary"),
        }),
        expect.objectContaining({
          id: "repository-review:dead",
          severity: "error",
          summary: expect.stringContaining("retry budget exhausted"),
        }),
      ]),
    );
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({ id: "repository-reviews", status: "attention" }),
    );
  });

  it("contains a collector timeout without blocking the whole snapshot", async () => {
    const startedAt = Date.now();
    const overview = await readRuntimeOverview({
      now: 1_000,
      sessions: [],
      collectorTimeoutMs: 10,
      readers: readers({
        runtimeGuardian: () => new Promise(() => undefined),
      }),
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({
        id: "runtime-guardian",
        status: "degraded",
        errorKind: "timeout",
      }),
    );
  });

  it("keeps dependency readiness and scheduled outcomes in the canonical model", async () => {
    const overview = await readRuntimeOverview({
      now: 2_000,
      sessions: [],
      readers: readers({
        automation: () => [
          {
            id: "loop",
            label: "Loop Engineering",
            enabled: true,
            configured: true,
            tickMs: 300_000,
            dependencies: { loopSupervisor: true },
          },
        ],
        workOrders: () => ({
          unfinished: [],
          terminal: [
            {
              id: "loop-passed",
              projectId: "alpha",
              projectName: "Alpha",
              taskKind: "architecture",
              status: "completed",
              scheduledAt: 1_000,
              updatedAt: 1_700,
            },
          ],
          abandoned: [],
          staleDispatching: [],
        }),
        dailyAudit: () => ({
          enabled: true,
          lastFiredAt: 1_900,
          summary: {
            active: 1,
            failed: 4,
            attention: 1,
            repairPending: 1,
            blocked: 2,
            deadLetter: 1,
          },
          outcomes: [
            {
              id: "ledger:audit-1",
              domain: "daily-audit",
              label: "Daily audit",
              status: "failed",
              endedAt: 1_800,
            },
          ],
        }),
        power: () => ({
          mode: "scheduled",
          phase: "service",
          powerSource: "ac",
          scheduleStatus: "verified",
          degraded: false,
          service: {
            uptimeMs: 60_000,
            adapters: { telegram: true, lark: false },
          },
        }),
      }),
    });

    expect(overview.automation[0]).toMatchObject({
      dependencies: { loopSupervisor: true },
      lastOutcome: { status: "passed", endedAt: 1_700 },
    });
    expect(overview.automation.find((item) => item.id === "loop")?.activeCount).toBe(0);
    expect(overview.attention.items).toContainEqual(
      expect.objectContaining({ id: "daily-task-audit:repair-pending" }),
    );
    expect(overview.recentOutcomes.items).toContainEqual(
      expect.objectContaining({ id: "ledger:audit-1", status: "failed" }),
    );
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({
        id: "daily-task-audit",
        summary: expect.stringContaining("4 failed, 1 repair pending, 2 blocked, 1 dead-letter"),
      }),
    );
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({
        id: "power",
        summary: expect.stringMatching(/up 60000ms.*telegram configured.*lark not configured/),
      }),
    );
  });

  it("keeps absent optional integrations informational", async () => {
    const overview = await readRuntimeOverview({ now: 1_000, sessions: [], readers: readers() });

    expect(overview.operator.promptLibrary.state).toBe("disabled");
    expect(overview.operator.optionalProjectMcpCount).toBe(0);
    expect(overview.health.status).toBe("healthy");
  });

  it("does not keep resolved historical failures in current attention", async () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    const overview = await readRuntimeOverview({
      now,
      sessions: [],
      readers: readers({
        workOrders: () => ({
          unfinished: [],
          terminal: [
            {
              id: "old-failure",
              projectId: "alpha",
              projectName: "Alpha",
              taskKind: "test-coverage",
              status: "failed",
              scheduledAt: 1,
              updatedAt: now - 2 * 24 * 60 * 60 * 1_000,
            },
          ],
          abandoned: [],
          staleDispatching: [],
        }),
      }),
    });

    expect(overview.recentOutcomes.items).toContainEqual(
      expect.objectContaining({ id: "work-order:old-failure", status: "failed" }),
    );
    expect(overview.attention.items).not.toContainEqual(
      expect.objectContaining({ id: "work-order:old-failure" }),
    );
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({ id: "work-orders", status: "healthy" }),
    );
  });

  it("does not keep completed WorkOrder repairs in current attention", async () => {
    const now = 10_000;
    const overview = await readRuntimeOverview({
      now,
      sessions: [],
      readers: readers({
        workOrders: () => ({
          unfinished: [],
          terminal: [
            {
              id: "repo-pr-review",
              projectId: "knowledge-engine-all-prs",
              projectName: "knowledge-engine all PRs",
              taskKind: "repository-pull-request-review",
              status: "failed",
              scheduledAt: 1_000,
              updatedAt: 9_000,
              repairStatus: "completed",
            },
          ],
          abandoned: [],
          staleDispatching: [],
        }),
      }),
    });

    expect(overview.recentOutcomes.items).toContainEqual(
      expect.objectContaining({ id: "work-order:repo-pr-review", status: "failed" }),
    );
    expect(overview.attention.items).not.toContainEqual(
      expect.objectContaining({ id: "work-order:repo-pr-review" }),
    );
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({ id: "work-orders", status: "healthy" }),
    );
  });

  it("does not warn about dependencies for an intentionally disabled automation", async () => {
    const overview = await readRuntimeOverview({
      now: 1_000,
      sessions: [],
      readers: readers({
        automation: () => [
          {
            id: "runtime-guardian",
            label: "Runtime Guardian",
            enabled: false,
            configured: true,
            tickMs: 0,
            dependencies: { loopSupervisor: false },
          },
        ],
      }),
    });

    expect(overview.attention.items).not.toContainEqual(
      expect.objectContaining({ id: "automation:runtime-guardian:dependency" }),
    );
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({ id: "automation", status: "healthy" }),
    );
  });

  it("treats an intentionally disabled Resource Guardian as disabled, not degraded", async () => {
    const overview = await readRuntimeOverview({
      now: 1_000,
      sessions: [],
      readers: readers({
        resourceGuardian: () => ({
          enabled: false,
          mode: "observe",
          profile: "balanced",
          pressure: "healthy",
          circuit: "open",
          changedAt: 0,
          degraded: true,
          samplingDegraded: true,
        }),
      }),
    });

    expect(overview.degradedDomains).not.toContain("resource-guardian");
    expect(overview.runtimeDomains).toContainEqual(
      expect.objectContaining({ id: "resource-guardian", status: "disabled" }),
    );
    expect(overview.health.status).toBe("healthy");
  });
});
