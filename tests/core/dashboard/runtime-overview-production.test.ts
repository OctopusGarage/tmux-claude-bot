import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendAutomationAdmissionEvent } from "../../../src/core/automation/admission-events.js";
import { AutomationOccurrenceStore } from "../../../src/core/automation/occurrence-window.js";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { RepositoryReviewQueue } from "../../../src/core/loop/repository-review-queue.js";
import { DailyTaskLedger } from "../../../src/core/tasks/task-ledger.js";

const registryRead = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/loop/supervisor-state.js", () => ({
  readLoopSupervisorWorkOrderRegistry: registryRead,
}));

import { createRuntimeOverviewReaders } from "../../../src/core/dashboard/runtime-overview-production.js";

function emptyRegistry() {
  return {
    records: [],
    unfinished: [],
    terminal: [],
    abandoned: [],
    staleDispatching: [],
  };
}

describe("production Runtime Overview readers", () => {
  it("keeps synchronous artifact scans out of the two-second TUI refresh path", () => {
    registryRead.mockReset();
    registryRead.mockReturnValue(emptyRegistry());
    const deps = {} as HandlerDeps;

    createRuntimeOverviewReaders({ deps, now: 1_000, operatorSessionRunning: false }).workOrders();
    createRuntimeOverviewReaders({ deps, now: 3_000, operatorSessionRunning: false }).workOrders();
    createRuntimeOverviewReaders({ deps, now: 30_999, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(1);

    createRuntimeOverviewReaders({ deps, now: 31_000, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(2);

    createRuntimeOverviewReaders({ deps, now: 500, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(3);
  });

  it("keeps Agent Capacity visible for Autopilot when no Loop config file is configured", () => {
    const deps = {
      config: {
        loopEngineering: {
          configFile: "",
          supervisor: { enabled: true, agent: "codex" },
        },
      },
      ownerActivity: { lastObservedAt: () => null },
    } as HandlerDeps;

    expect(
      createRuntimeOverviewReaders({
        deps,
        now: 1_000,
        operatorSessionRunning: false,
      }).agentCapacity?.(),
    ).toMatchObject({ enabled: true, agent: "codex" });
  });

  it("settles terminal ledger occurrences before reporting planned Agent Capacity work", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const occurrence = new AutomationOccurrenceStore({ randomOffset: () => 0 }).plan({
        key: "tmux-claude-bot:bug-fix:bug-fix",
        scheduledAt: 1_000,
        windowMs: 0,
        now: 1_000,
      });
      new AutomationOccurrenceStore().setStatus(occurrence.id, "admitted", 1_100);

      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: "loop:tmux-claude-bot:bug-fix:1000",
        source: "loop-engineering",
        name: "tmux-claude-bot bug-fix",
        scheduledAt: 1_000,
      });
      ledger.fail("loop:tmux-claude-bot:bug-fix:1000", {
        endedAt: 1_200,
        error: "supervisor failed",
      });
      ledger.markRepairStatus("loop:tmux-claude-bot:bug-fix:1000", {
        repairStatus: "fixed",
        updatedAt: 1_300,
      });

      const result = createRuntimeOverviewReaders({
        deps: {
          config: {
            loopEngineering: {
              supervisor: { enabled: true, agent: "codex" },
            },
          },
          ownerActivity: { lastObservedAt: () => null },
        } as HandlerDeps,
        now: 2_000,
        operatorSessionRunning: false,
      }).agentCapacity?.();

      expect(result).toMatchObject({
        plannedOccurrences: 0,
        nextOccurrenceAt: null,
      });
      expect(new AutomationOccurrenceStore().get(occurrence.id)).toMatchObject({
        status: "settled",
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports only future Agent Capacity occurrence timestamps", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      new AutomationOccurrenceStore({ randomOffset: () => 0 }).plan({
        key: "tmux-claude-bot:bug-fix:bug-fix",
        scheduledAt: 1_000,
        windowMs: 0,
        now: 1_000,
      });
      new AutomationOccurrenceStore({ randomOffset: () => 0 }).plan({
        key: "tmux-claude-bot:test-coverage:test-coverage",
        scheduledAt: 3_000,
        windowMs: 0,
        now: 2_000,
      });

      const result = createRuntimeOverviewReaders({
        deps: {
          config: {
            loopEngineering: {
              supervisor: { enabled: true, agent: "codex" },
            },
          },
          ownerActivity: { lastObservedAt: () => null },
        } as HandlerDeps,
        now: 2_000,
        operatorSessionRunning: false,
      }).agentCapacity?.();

      expect(result).toMatchObject({
        plannedOccurrences: 2,
        nextOccurrenceAt: 3_000,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reconciles legacy loop ledger task ids to terminal WorkOrder repair status", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    registryRead.mockReset();
    registryRead.mockReturnValue({
      records: [
        {
          workOrder: {
            id: "1000-alpha",
            projectId: "alpha",
            projectName: "Alpha",
            scheduledAt: 1_000,
            task: { kind: "architecture" },
          },
          state: { status: "failed", updatedAt: 1_100 },
        },
      ],
      unfinished: [],
      terminal: [
        {
          workOrder: {
            id: "1000-alpha",
            projectId: "alpha",
            projectName: "Alpha",
            scheduledAt: 1_000,
            task: { kind: "architecture" },
          },
          state: { status: "failed", updatedAt: 1_100 },
        },
      ],
      abandoned: [],
      staleDispatching: [],
    });
    try {
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: "loop:alpha:1000",
        source: "loop-engineering",
        name: "Alpha architecture",
        scheduledAt: 1_000,
      });
      ledger.fail("loop:alpha:1000", { endedAt: 1_100, error: "blocked" });
      ledger.markRepairStatus("loop:alpha:1000", {
        repairStatus: "blocked",
        updatedAt: 1_200,
      });

      const result = await createRuntimeOverviewReaders({
        deps: {} as HandlerDeps,
        now: 1_300,
        operatorSessionRunning: false,
      }).workOrders();

      expect(result.terminal).toEqual([
        expect.objectContaining({
          id: "1000-alpha",
          repairStatus: "blocked",
        }),
      ]);
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      registryRead.mockReset();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("projects repaired non-loop ledger failures as passed recent outcomes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: "system-self-heal:agent-sweep:1000",
        source: "system-self-heal",
        name: "tmux-claude-bot system self-heal agent sweep",
        scheduledAt: 1_000,
      });
      ledger.fail("system-self-heal:agent-sweep:1000", {
        endedAt: 1_100,
        error: "automation admission deferred: critical resource pressure",
      });
      ledger.markRepairStatus("system-self-heal:agent-sweep:1000", {
        repairStatus: "not-reproducible",
        updatedAt: 1_200,
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now: 1_300,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.outcomes).toContainEqual(
        expect.objectContaining({
          id: "ledger:system-self-heal:agent-sweep:1000",
          domain: "system-self-heal",
          status: "passed",
        }),
      );
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not surface superseded terminal repository-review occurrences as current attention", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const queue = new RepositoryReviewQueue();
      const old = queue.enqueue({
        repositoryId: "tmux-claude-bot-all-prs",
        scheduledAt: 1_000,
        priority: 100,
        now: 1_000,
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const at = 1_000 + attempt * 100;
        expect(queue.lease(old.id, "worker", at, 1_000)).not.toBeNull();
        expect(queue.retry(old.id, "worker", at + 50, "blocked", at + 50)).toBe(true);
      }
      expect(queue.list({ all: true }).find((item) => item.id === old.id)).toMatchObject({
        status: "dead-letter",
      });

      queue.enqueue({
        repositoryId: "tmux-claude-bot-all-prs",
        scheduledAt: 2_000,
        priority: 100,
        now: 2_000,
      });
      expect(queue.completeOccurrence("tmux-claude-bot-all-prs", 2_000, 2_100, "completed")).toBe(
        true,
      );

      const result = createRuntimeOverviewReaders({
        deps: {} as HandlerDeps,
        now: 3_000,
        operatorSessionRunning: false,
      }).repositoryReviews();

      expect(result).toEqual([]);
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not surface closed repository-review repairs as current attention", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const repositoryId = "tmux-claude-bot-all-prs";
      const scheduledAt = 2_000;
      const taskId = `loop:pr-review:${repositoryId}:${scheduledAt}`;
      const queue = new RepositoryReviewQueue();
      const item = queue.enqueue({
        repositoryId,
        scheduledAt,
        priority: 100,
        now: scheduledAt,
      });
      expect(queue.lease(item.id, "worker", scheduledAt + 100, 1_000)).not.toBeNull();
      expect(
        queue.retry(
          item.id,
          "worker",
          scheduledAt + 200,
          "recovered supervisor work order result: supervisor-failed",
          scheduledAt + 3_600_000,
        ),
      ).toBe(true);

      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "tmux-claude-bot-all-prs repository-pull-request-review",
        scheduledAt,
      });
      ledger.fail(taskId, { endedAt: scheduledAt + 300, error: "supervisor-failed" });
      ledger.markRepairStatus(taskId, {
        repairStatus: "fixed",
        updatedAt: scheduledAt + 400,
      });

      const result = createRuntimeOverviewReaders({
        deps: {} as HandlerDeps,
        now: scheduledAt + 500,
        operatorSessionRunning: false,
      }).repositoryReviews();

      expect(result).toEqual([]);
      expect(new RepositoryReviewQueue().list({ all: true })).toEqual([
        expect.objectContaining({
          id: item.id,
          status: "completed",
          lastError: "reconciled from daily task ledger repairStatus=fixed",
        }),
      ]);
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not count blocked Daily Task Audit repairs as current attention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const taskId = "daily-audit:self:1000";
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "daily-audit",
        name: "Daily Task Audit self-check",
        scheduledAt: 1_000,
      });
      ledger.fail(taskId, {
        endedAt: 1_100,
        error: "owner decision required",
      });
      ledger.markRepairStatus(taskId, {
        repairStatus: "blocked",
        updatedAt: 1_200,
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now: 1_300,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 0,
        blocked: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not count completed Daily Task Audit repairs as current attention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const taskId = "loop:pr-review:knowledge-engine-all-prs:1000";
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "knowledge-engine-all-prs repository-pull-request-review",
        scheduledAt: 1_000,
      });
      ledger.fail(taskId, {
        endedAt: 1_100,
        error: "dispatch-failed",
      });
      ledger.markRepairStatus(taskId, {
        repairStatus: "completed",
        updatedAt: 1_200,
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now: 1_300,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 0,
        completed: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("counts missing Daily Task Audit records without repair status as pending repair", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-30T12:00:00+08:00");
      const scheduledAt = Date.parse("2026-08-29T10:00:00+08:00");
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: "loop:tmux-claude-bot:bug-fix:2026-08-29",
        source: "loop-engineering",
        name: "tmux-claude-bot bug-fix",
        scheduledAt,
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 1,
        repairPending: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not count quiet-hours Daily Task Audit repair deferrals as current attention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-31T04:10:00+08:00");
      const ledger = new DailyTaskLedger();
      for (const [projectId, scheduledAt] of [
        ["geo-backend-all-prs", Date.parse("2026-08-30T11:20:00+08:00")],
        ["net-auto-switch-all-prs", Date.parse("2026-08-30T12:20:00+08:00")],
      ] as const) {
        const taskId = `loop:pr-review:${projectId}:${scheduledAt}`;
        ledger.expect({
          taskId,
          source: "loop-engineering",
          name: `${projectId} repository-pull-request-review`,
          scheduledAt,
          summary: "Recovery dispatch deferred: automation admission deferred: quiet-hours",
        });
      }

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 2,
        attention: 0,
        repairPending: 2,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses admission events to keep quiet-hours Daily Task Audit repairs out of current attention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-31T04:10:00+08:00");
      const scheduledAt = Date.parse("2026-08-30T15:20:00+08:00");
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: `loop:geo-frontend:test-coverage:${scheduledAt}`,
        source: "loop-engineering",
        name: "geo-frontend test-coverage",
        scheduledAt,
        summary:
          "loop-engineering schedule discovered; no explicit run record was found yet; Reconciled missing expected task after its scheduled time passed without a run record.",
      });
      appendAutomationAdmissionEvent({
        at: now - 60_000,
        kind: "deferred",
        source: "loop-engineering",
        intentId: `geo-frontend:test-coverage:${scheduledAt}`,
        agent: "codex",
        occurrenceId: `geo-frontend:test-coverage:test-coverage@${scheduledAt}`,
        reason: "quiet-hours",
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses direct admission intent matches for current Daily Task Audit repair deferrals", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-31T04:10:00+08:00");
      const scheduledAt = Date.parse("2026-08-30T15:20:00+08:00");
      const taskId = `loop:geo-frontend:test-coverage:${scheduledAt}`;
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "geo-frontend test-coverage",
        scheduledAt,
        summary:
          "loop-engineering schedule discovered; no explicit run record was found yet; Reconciled missing expected task after its scheduled time passed without a run record.",
      });
      appendAutomationAdmissionEvent({
        at: now - 60_000,
        kind: "deferred",
        source: "loop-engineering",
        intentId: taskId,
        agent: "codex",
        reason: "autonomous-heavy-active-lease",
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps capacity-unknown active-lease deferrals out of current Daily Task Audit attention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-31T04:10:00+08:00");
      const scheduledAt = Date.parse("2026-08-30T15:20:00+08:00");
      const taskId = `loop:geo-frontend:test-coverage:${scheduledAt}`;
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "geo-frontend test-coverage",
        scheduledAt,
        summary:
          "loop-engineering schedule discovered; no explicit run record was found yet; Reconciled missing expected task after its scheduled time passed without a run record.",
      });
      appendAutomationAdmissionEvent({
        at: now - 10 * 60_000,
        kind: "deferred",
        source: "loop-engineering",
        intentId: taskId,
        agent: "codex",
        occurrenceId: `geo-frontend:test-coverage:test-coverage@${scheduledAt}`,
        reason: "capacity-unknown-active-lease",
      });
      for (let index = 0; index < 220; index += 1) {
        appendAutomationAdmissionEvent({
          at: now - 9 * 60_000 + index,
          kind: "deferred",
          source: "loop-engineering",
          intentId: `unrelated:${index}`,
          agent: "codex",
          reason: "quiet-hours",
        });
      }

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps planned occurrence-window work out of current Daily Task Audit attention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-31T04:10:00+08:00");
      const scheduledAt = Date.parse("2026-08-30T23:40:00+08:00");
      const taskId = `loop:english-pilot:test-coverage:${scheduledAt}`;
      new AutomationOccurrenceStore({ randomOffset: () => 0 }).plan({
        key: "english-pilot:test-coverage:test-coverage",
        scheduledAt,
        windowMs: 60 * 60_000,
        now: scheduledAt,
        source: "loop-engineering",
      });
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "english-pilot test-coverage",
        scheduledAt,
        summary: "loop-engineering schedule discovered; no explicit run record was found yet",
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses repository-review queue admission events for current missing review repairs", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-31T04:10:00+08:00");
      const scheduledAt = Date.parse("2026-08-30T12:20:00+08:00");
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: `loop:pr-review:geo-backend-all-prs:${scheduledAt}`,
        source: "loop-engineering",
        name: "geo-backend-all-prs repository-pull-request-review",
        scheduledAt,
        summary:
          "loop-engineering schedule discovered; no explicit run record was found yet; Reconciled missing expected task after its scheduled time passed without a run record.",
      });
      appendAutomationAdmissionEvent({
        at: now - 60_000,
        kind: "deferred",
        source: "loop-engineering",
        intentId: "loop-engineering:repository-review-queue-tick",
        agent: "codex",
        reason: "quiet-hours",
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps current Daily Task Audit attention when admission events are not transient", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = Date.parse("2026-08-31T04:10:00+08:00");
      const scheduledAt = Date.parse("2026-08-30T15:20:00+08:00");
      const taskId = `loop:geo-frontend:test-coverage:${scheduledAt}`;
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "geo-frontend test-coverage",
        scheduledAt,
        summary:
          "loop-engineering schedule discovered; no explicit run record was found yet; Reconciled missing expected task after its scheduled time passed without a run record.",
      });
      appendAutomationAdmissionEvent({
        at: now - 60_000,
        kind: "deferred",
        source: "loop-engineering",
        intentId: taskId,
        agent: "codex",
        reason: "owner decision needed",
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 1,
        repairPending: 1,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not report historical Daily Task Audit pending repairs as current attention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = 10 * 24 * 60 * 60 * 1_000;
      const taskId = "loop:tmux-claude-bot:bug-fix:historical";
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "tmux-claude-bot bug-fix",
        scheduledAt: now - 5 * 24 * 60 * 60 * 1_000,
      });
      ledger.fail(taskId, {
        endedAt: now - 5 * 24 * 60 * 60 * 1_000 + 1_000,
        error: "old failure",
      });

      const result = await createRuntimeOverviewReaders({
        deps: {
          config: {
            taskAudit: { enabled: true, tickMs: 300_000 },
          },
        } as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).dailyAudit();

      expect(result.summary).toMatchObject({
        failed: 1,
        attention: 0,
        repairPending: 0,
      });
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("attaches closed ledger repair status to terminal WorkOrders", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = 10_000;
      const id = "run-closed";
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: `autopilot:${id}`,
        source: "autopilot-delegate",
        name: "tmux-claude-bot active delegated task",
        scheduledAt: now - 2_000,
      });
      ledger.fail(`autopilot:${id}`, {
        endedAt: now - 1_000,
        error: "active delegation ended with blocked",
      });
      ledger.markRepairStatus(`autopilot:${id}`, {
        repairStatus: "superseded",
        updatedAt: now - 500,
      });

      registryRead.mockReset();
      registryRead.mockReturnValue({
        ...emptyRegistry(),
        records: [
          {
            workOrder: {
              id,
              projectId: "tmux-claude-bot",
              projectName: "tmux-claude-bot",
              projectPath: "/tmp/project",
              scheduledAt: now - 2_000,
              requiredFinalMarker: "FINAL",
              task: { kind: "active-delegated-task" },
            },
            state: {
              status: "failed",
              projectId: "tmux-claude-bot",
              runId: id,
              supervisorSession: "tmux_proj_loop-supervisor-1",
              scheduledAt: now - 2_000,
              updatedAt: now - 1_000,
            },
            runDir: "/tmp/run",
          },
        ],
        terminal: [
          {
            workOrder: {
              id,
              projectId: "tmux-claude-bot",
              projectName: "tmux-claude-bot",
              projectPath: "/tmp/project",
              scheduledAt: now - 2_000,
              requiredFinalMarker: "FINAL",
              task: { kind: "active-delegated-task" },
            },
            state: {
              status: "failed",
              projectId: "tmux-claude-bot",
              runId: id,
              supervisorSession: "tmux_proj_loop-supervisor-1",
              scheduledAt: now - 2_000,
              updatedAt: now - 1_000,
            },
            runDir: "/tmp/run",
          },
        ],
      });

      const result = await createRuntimeOverviewReaders({
        deps: {} as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).workOrders();

      expect(result.terminal).toEqual([
        expect.objectContaining({
          id,
          repairStatus: "superseded",
        }),
      ]);
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("attaches closed repository-review ledger repair status to terminal WorkOrders", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-dashboard-overview-"));
    const originalStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const now = 10_000;
      const scheduledAt = now - 2_000;
      const id = "run-repository-review";
      const projectId = "tmux-claude-bot-all-prs";
      const taskId = `loop:pr-review:${projectId}:${scheduledAt}`;
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "tmux-claude-bot-all-prs repository-pull-request-review",
        scheduledAt,
      });
      ledger.fail(taskId, {
        endedAt: now - 1_000,
        error: "supervisor-failed",
      });
      ledger.markRepairStatus(taskId, {
        repairStatus: "fixed",
        updatedAt: now - 500,
      });

      registryRead.mockReset();
      registryRead.mockReturnValue({
        ...emptyRegistry(),
        terminal: [
          {
            workOrder: {
              id,
              projectId,
              projectName: "tmux-claude-bot all PRs",
              projectPath: "/tmp/project",
              scheduledAt,
              requiredFinalMarker: "FINAL",
              task: { kind: "repository-pull-request-review" },
            },
            state: {
              status: "failed",
              projectId,
              runId: id,
              supervisorSession: "tmux_proj_loop-supervisor-1",
              scheduledAt,
              updatedAt: now - 1_000,
            },
            runDir: "/tmp/run",
          },
        ],
      });

      const result = await createRuntimeOverviewReaders({
        deps: {} as HandlerDeps,
        now,
        operatorSessionRunning: false,
      }).workOrders();

      expect(result.terminal).toEqual([
        expect.objectContaining({
          id,
          repairStatus: "fixed",
        }),
      ]);
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
