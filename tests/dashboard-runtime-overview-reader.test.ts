import { describe, expect, it } from "vitest";
import {
  type RuntimeOverviewReaders,
  readRuntimeOverview,
} from "../src/core/dashboard/runtime-overview-reader.js";

function readers(overrides: Partial<RuntimeOverviewReaders> = {}): RuntimeOverviewReaders {
  return {
    automation: () => [],
    workOrders: () => ({
      unfinished: [],
      terminal: [],
      abandoned: [],
      staleDispatching: [],
    }),
    repositoryReviews: () => [],
    dailyAudit: () => ({
      enabled: true,
      summary: { active: 0, failed: 0, attention: 0, repairPending: 0 },
      outcomes: [],
    }),
    runtimeGuardian: () => ({ enabled: true, findings: [] }),
    resourceGuardian: () => ({
      enabled: true,
      mode: "protect",
      profile: "balanced",
      pressure: "healthy",
      circuit: "open",
      changedAt: 1,
      degraded: false,
      samplingDegraded: false,
    }),
    agentCapacity: () => ({
      enabled: true,
      agent: "codex",
      authentication: "subscription",
      state: "available",
      observedAt: 1,
      retryAt: null,
      activeAutonomousLeases: 0,
      plannedOccurrences: 0,
      nextOccurrenceAt: null,
      ownerLastActivityAt: null,
    }),
    power: () => ({
      mode: "scheduled",
      phase: "active",
      powerSource: "AC Power",
      scheduleStatus: "verified",
      degraded: false,
    }),
    operator: () => ({
      session: { state: "ready" },
      skills: { installed: 2, expected: 2, state: "ready" },
      mcpProfiles: { installed: 2, expected: 2, state: "ready", profiles: [] },
      promptLibrary: { state: "configured" },
      optionalProjectMcpCount: null,
    }),
    ...overrides,
  };
}

describe("readRuntimeOverview", () => {
  it("does not report recent failed WorkOrders whose ledger repair is closed", async () => {
    const now = 1787064600000;
    const overview = await readRuntimeOverview({
      now,
      sessions: [],
      readers: readers({
        workOrders: () => ({
          unfinished: [],
          terminal: [
            {
              id: "1787057816707-tmux-claude-bot-active-delegate",
              projectId: "tmux-claude-bot",
              projectName: "tmux-claude-bot",
              taskKind: "active-delegated-task",
              status: "failed",
              scheduledAt: now - 60_000,
              updatedAt: now - 30_000,
              repairStatus: "superseded",
            },
          ],
          abandoned: [],
          staleDispatching: [],
        }),
      }),
    });

    expect(overview.health.status).toBe("healthy");
    expect(overview.attention.items).toEqual([]);
    expect(overview.runtimeDomains.find((domain) => domain.id === "work-orders")).toMatchObject({
      status: "healthy",
    });
  });
});
