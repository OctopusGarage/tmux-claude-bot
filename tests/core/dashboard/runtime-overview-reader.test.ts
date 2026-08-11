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
    batch: () => ({ enabled: true }),
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
          summary: { active: 1, failed: 1, attention: 1, repairPending: 1 },
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
        summary: expect.stringContaining("1 failed"),
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
