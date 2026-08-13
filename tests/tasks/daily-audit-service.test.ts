import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startActiveDelegatedTask } from "../../src/core/autopilot/delegated-task.js";
import { NotificationGateway } from "../../src/core/notifications/gateway.js";
import {
  DailyTaskAuditStore,
  dispatchDailyTaskRepair,
  runDailyTaskAuditServiceTick,
} from "../../src/core/tasks/daily-audit-service.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";
import { buildDailyAuditRepairPrompt } from "../../src/core/tasks/task-repair.js";

vi.mock("../../src/core/autopilot/delegated-task.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/autopilot/delegated-task.js")>()),
  startActiveDelegatedTask: vi.fn(async () => ({
    status: "queued",
    runId: "repair-run-1",
    projectId: "tmux-claude-bot",
    supervisorSession: "tmux_proj_loop-supervisor",
    reportDir: "/tmp/repair-report",
  })),
}));

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("runDailyTaskAuditServiceTick", () => {
  it("serializes overlapping audit ticks instead of dispatching duplicate repairs", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-lock-"));
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reconcileGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = {
      now: Date.parse("2026-07-28T02:05:00Z"),
      config: {
        enabled: true,
        tickMs: 300000,
        schedule: "0 2 * * *",
        repoPath: "/repo/tmux-claude-bot",
        repairBranch: "dev",
        autoRepair: false,
        repairWorktreeIsolation: "isolated" as const,
        channel: "lark" as const,
      },
      notifications: new NotificationGateway(),
      discover: () => [],
      reconcile: async () => {
        entered();
        await reconcileGate;
      },
    };
    const first = runDailyTaskAuditServiceTick(input);
    await enteredPromise;
    await expect(runDailyTaskAuditServiceTick(input)).resolves.toEqual({
      fired: false,
      reason: "in-progress",
    });
    release();
    await first;
  });

  it("reopens stale repair statuses after the repair worker is no longer active", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-daily-audit-stale-repair-"));
    process.env.TCB_STATE_DIR = stateDir;
    const ledger = new DailyTaskLedger();
    const scheduledAt = Date.parse("2026-07-27T02:00:00Z");
    ledger.expect({
      taskId: "loop:stale:failed",
      source: "loop-engineering",
      name: "stale task",
      scheduledAt,
    });
    ledger.fail("loop:stale:failed", { endedAt: scheduledAt + 1000, error: "failed" });
    ledger.markRepairStatus("loop:stale:failed", {
      repairStatus: "running",
      updatedAt: Date.parse("2026-07-27T03:00:00Z"),
    });

    await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:00:00Z"),
      config: {
        enabled: true,
        tickMs: 300000,
        schedule: "0 2 * * *",
        repoPath: "/repo/tmux-claude-bot",
        repairBranch: "dev",
        autoRepair: false,
        repairWorktreeIsolation: "isolated",
        channel: "lark",
      },
      notifications: new NotificationGateway(),
      ledger,
      store: new DailyTaskAuditStore(),
      force: true,
    });

    expect(ledger.listAll().find((record) => record.taskId === "loop:stale:failed")).toMatchObject({
      repairStatus: "pending",
    });
  });

  it("fires once when the audit schedule is due and records the audit task", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-service-"));
    const notifications = new NotificationGateway();
    const send = vi.fn(async () => {});
    notifications.register("lark", send);
    const ledger = new DailyTaskLedger();
    const first = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:05:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: false,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      discover: () => [],
    });
    const second = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:06:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: false,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      discover: () => [],
    });

    expect(first).toMatchObject({ fired: true });
    expect(second).toMatchObject({ fired: false, reason: "not-due" });
    expect(send).not.toHaveBeenCalled();
    expect(
      ledger.listForWindow({
        start: Date.parse("2026-07-28T00:00:00Z"),
        end: Date.parse("2026-07-29T00:00:00Z"),
        label: "2026-07-28 UTC",
      })[0],
    ).toMatchObject({
      taskId: `daily-audit:${Date.parse("2026-07-28T02:00:00Z")}`,
      source: "daily-audit",
      status: "success",
    });
  });

  it("catches the latest missed audit when first started after the schedule window", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-service-"));
    const notifications = new NotificationGateway();
    const send = vi.fn(async () => {});
    notifications.register("lark", send);

    const result = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T05:30:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: false,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      discover: () => [],
    });

    expect(result).toMatchObject({
      fired: true,
      scheduledAt: Date.parse("2026-07-28T02:00:00Z"),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("can be forced to run immediately even when the schedule is not due", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-force-"));
    const notifications = new NotificationGateway();
    const send = vi.fn(async () => {});
    notifications.register("lark", send);

    const result = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T01:30:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: false,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      discover: () => [],
      force: true,
    });

    expect(result).toMatchObject({
      fired: true,
      scheduledAt: Date.parse("2026-07-28T01:30:00Z"),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches repair when auto repair is enabled and the audit finds failures", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-repair-"));
    const notifications = new NotificationGateway();
    const events: string[] = [];
    const send = vi.fn(async (message: string) => {
      events.push(`notify:${message}`);
    });
    notifications.register("lark", send);
    const ledger = new DailyTaskLedger();
    const failedAt = Date.parse("2026-07-27T02:00:00Z");
    ledger.expect({
      taskId: "radar:daily:failed",
      source: "radar-monitor",
      name: "daily radar",
      scheduledAt: failedAt,
    });
    ledger.fail("radar:daily:failed", { endedAt: failedAt + 1000, error: "missing output" });
    const dispatchRepair = vi.fn(async () => {
      events.push("dispatch");
      return { status: "queued" as const, detail: "runId=repair-run-1" };
    });

    await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:05:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      dispatchRepair,
      discover: () => [],
    });

    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/repo/tmux-claude-bot",
        repairBranch: "dev",
        items: [expect.objectContaining({ taskId: "radar:daily:failed" })],
      }),
    );
    expect(events[0]).toBe("dispatch");
    expect(events[1]).toContain("Repair: 1 candidates · queued - runId=repair-run-1");
    expect(
      ledger.listForWindow({
        start: Date.parse("2026-07-27T00:00:00Z"),
        end: Date.parse("2026-07-28T00:00:00Z"),
        label: "2026-07-27 UTC",
      })[0],
    ).toMatchObject({
      taskId: "radar:daily:failed",
      repairStatus: "running",
    });
  });

  it("persists discovered missing tasks so the repair worker receives and settles them", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-discovered-repair-"));
    const notifications = new NotificationGateway();
    notifications.register(
      "lark",
      vi.fn(async () => undefined),
    );
    const ledger = new DailyTaskLedger();
    const dispatchRepair = vi.fn(async () => ({
      status: "queued" as const,
      detail: "runId=repair-missing-1",
      runId: "repair-missing-1",
    }));

    await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:05:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      dispatchRepair,
      discover: ({ window }) => [
        {
          taskId: "loop:geo:security-maintenance:1",
          source: "loop-engineering",
          name: "geo security-maintenance",
          scheduledAt: window.start,
          status: "expected",
          updatedAt: window.start,
        },
      ],
      force: true,
    });

    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            taskId: "loop:geo:security-maintenance:1",
            status: "missing",
          }),
        ],
      }),
    );
    expect(ledger.listAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "loop:geo:security-maintenance:1",
          status: "expected",
          repairStatus: "running",
        }),
      ]),
    );
  });

  it("finishes the audit when repair dispatch fails", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-repair-fails-"));
    const notifications = new NotificationGateway();
    const sentMessages: string[] = [];
    const send = vi.fn(async (message: string) => {
      sentMessages.push(message);
    });
    notifications.register("lark", send);
    const ledger = new DailyTaskLedger();
    const failedAt = Date.parse("2026-07-27T02:00:00Z");
    ledger.expect({
      taskId: "radar:daily:failed",
      source: "radar-monitor",
      name: "daily radar",
      scheduledAt: failedAt,
    });
    ledger.fail("radar:daily:failed", { endedAt: failedAt + 1000, error: "missing output" });

    const result = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:05:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      dispatchRepair: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      discover: () => [],
    });

    expect(result).toMatchObject({ fired: true, failures: 1 });
    expect(sentMessages[0]).toContain("Repair: 1 candidates · failed");
    expect(
      ledger.listForWindow({
        start: Date.parse("2026-07-28T00:00:00Z"),
        end: Date.parse("2026-07-29T00:00:00Z"),
        label: "2026-07-28 UTC",
      })[0],
    ).toMatchObject({
      status: "success",
      summary: expect.stringContaining("failures=1 repair-dispatch=failed"),
    });
  });

  it("returns capacity and active-automation deferrals directly to the queue", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-capacity-"));
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:tmux-claude-bot:capacity",
      source: "loop-engineering",
      name: "tmux-claude-bot architecture",
      scheduledAt: 1,
    });
    ledger.fail("loop:tmux-claude-bot:capacity", { endedAt: 2, error: "dispatch-failed" });

    await runDailyTaskAuditServiceTick({
      now: 3,
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications: new NotificationGateway(),
      ledger,
      dispatchRepair: vi.fn(async () => ({
        status: "blocked" as const,
        detail: "project already has active automation",
      })),
      force: true,
    });

    const { RepairCoordinator } = await import("../../src/core/tasks/repair-coordinator.js");
    expect(new RepairCoordinator().list()[0]).toMatchObject({
      status: "pending",
      nextAttemptAt: 3,
    });
  });

  it("does not let generic daily repair dispatch claim project-recovery records", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(
      join(tmpdir(), "tcb-daily-audit-project-recovery-owner-"),
    );
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "autopilot:historical-recovery",
      source: "autopilot-delegate",
      name: "tmux-claude-bot active delegated task",
      scheduledAt: 1,
    });
    ledger.fail("autopilot:historical-recovery", {
      endedAt: 2,
      error: "orphaned-supervisor-worker",
    });
    const { RepairCoordinator } = await import("../../src/core/tasks/repair-coordinator.js");
    const coordinator = new RepairCoordinator();
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "tmux-claude-bot active delegated task",
      fingerprint: "orphaned-supervisor-worker",
      taskId: "autopilot:historical-recovery",
      now: 3,
    });
    const dispatchRepair = vi.fn(async () => ({
      status: "queued" as const,
      detail: "should not be called",
    }));

    await runDailyTaskAuditServiceTick({
      now: 3,
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications: new NotificationGateway(),
      ledger,
      coordinator,
      dispatchRepair,
      force: true,
    });

    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(coordinator.list()[0]).toMatchObject({ status: "pending" });
  });

  it("terminalizes queue records that have no ledger evidence", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-missing-evidence-"));
    const { RepairCoordinator } = await import("../../src/core/tasks/repair-coordinator.js");
    const coordinator = new RepairCoordinator();
    const queueRecord = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "loop-engineering",
      taskFamily: "missing-run",
      fingerprint: "no explicit run record",
      taskId: "loop:missing-run",
      now: 1,
    });
    const result = await runDailyTaskAuditServiceTick({
      now: 2,
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications: new NotificationGateway(),
      coordinator,
      dispatchRepair: vi.fn(async () => ({ status: "queued" as const, detail: "test" })),
      force: true,
    });

    expect(result.fired).toBe(true);
    if (!result.fired) throw new Error("expected forced audit to fire");
    expect(result.repairDispatch).toContain("no ledger evidence");
    expect(coordinator.list()).toEqual([
      expect.objectContaining({ id: queueRecord.id, status: "blocked" }),
    ]);
  });

  it("self-audits the previous daily audit when its repair dispatch failed", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-self-repair-"));
    const notifications = new NotificationGateway();
    const sentMessages: string[] = [];
    const send = vi.fn(async (message: string) => {
      sentMessages.push(message);
    });
    notifications.register("lark", send);
    const ledger = new DailyTaskLedger();
    const previousAuditAt = Date.parse("2026-07-28T02:00:00Z");
    const currentAuditAt = Date.parse("2026-07-29T02:00:00Z");
    ledger.expect({
      taskId: `daily-audit:${previousAuditAt}`,
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: previousAuditAt,
    });
    ledger.finish(`daily-audit:${previousAuditAt}`, {
      endedAt: previousAuditAt + 1000,
      summary: "failures=1 repair-dispatch=failed notification=sent",
    });
    const dispatchRepair = vi.fn(async () => ({
      status: "queued" as const,
      detail: "runId=self-repair-1",
    }));

    const result = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-29T02:05:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      dispatchRepair,
      discover: () => [],
    });

    expect(result).toMatchObject({ fired: true, scheduledAt: currentAuditAt, failures: 1 });
    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        repairBranch: "dev",
        items: [
          expect.objectContaining({
            taskId: `daily-audit:self:${previousAuditAt}`,
            source: "daily-audit",
            status: "failed",
            error: expect.stringContaining("repair-dispatch=failed"),
          }),
        ],
      }),
    );
    expect(sentMessages[0]).toContain("Daily task audit self-check · failed · unknown");
    expect(sentMessages[0]).toContain("Repair: 1 candidates · queued - runId=self-repair-1");
  });

  it("self-audits partial previous audit notification without re-dispatching active self repair", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-self-active-"));
    const notifications = new NotificationGateway();
    const send = vi.fn(async () => {});
    notifications.register("lark", send);
    const ledger = new DailyTaskLedger();
    const previousAuditAt = Date.parse("2026-07-28T02:00:00Z");
    const selfTaskId = `daily-audit:self:${previousAuditAt}`;
    ledger.expect({
      taskId: `daily-audit:${previousAuditAt}`,
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: previousAuditAt,
    });
    ledger.finish(`daily-audit:${previousAuditAt}`, {
      endedAt: previousAuditAt + 1000,
      summary: "failures=0 repair-dispatch=not-needed notification=partial",
    });
    ledger.expect({
      taskId: selfTaskId,
      source: "daily-audit",
      name: "Daily task audit self-check",
      scheduledAt: previousAuditAt,
    });
    ledger.fail(selfTaskId, {
      endedAt: previousAuditAt + 2000,
      error: "previous audit notification=partial",
    });
    ledger.markRepairStatus(selfTaskId, {
      repairStatus: "running",
      updatedAt: previousAuditAt + 3000,
      summary: "Self repair already delegated.",
    });
    const dispatchRepair = vi.fn(async () => ({
      status: "queued" as const,
      detail: "runId=duplicate-self-repair",
    }));

    const result = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-29T02:05:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: true,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      dispatchRepair,
      discover: () => [],
    });

    expect(result).toMatchObject({ fired: true, failures: 0 });
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("does not mark the audit complete when the final notification cannot be delivered", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-notify-fails-"));
    const notifications = new NotificationGateway();
    const send = vi.fn(async () => {
      throw new Error("lark unavailable");
    });
    notifications.register("lark", send);
    const ledger = new DailyTaskLedger();
    const failedAt = Date.parse("2026-07-27T01:00:00Z");
    ledger.expect({
      taskId: "loop:notification-failure",
      source: "loop-engineering",
      name: "notification failure fixture",
      scheduledAt: failedAt,
    });
    ledger.fail("loop:notification-failure", {
      endedAt: failedAt + 1_000,
      error: "system gate failed",
    });

    const first = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:05:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: false,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      discover: () => [],
    });
    const second = await runDailyTaskAuditServiceTick({
      now: Date.parse("2026-07-28T02:06:00Z"),
      config: {
        enabled: true,
        schedule: "0 2 * * *",
        tickMs: 300000,
        channel: "lark",
        autoRepair: false,
        repairBranch: "dev",
        repoPath: "/repo/tmux-claude-bot",
        repairWorktreeIsolation: "isolated",
      },
      notifications,
      ledger,
      discover: () => [],
    });

    expect(first).toMatchObject({ fired: true });
    expect(second).toMatchObject({
      fired: true,
      scheduledAt: Date.parse("2026-07-28T02:00:00Z"),
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      ledger.listForWindow({
        start: Date.parse("2026-07-28T00:00:00Z"),
        end: Date.parse("2026-07-29T00:00:00Z"),
        label: "2026-07-28 UTC",
      })[0],
    ).toMatchObject({
      taskId: `daily-audit:${Date.parse("2026-07-28T02:00:00Z")}`,
      source: "daily-audit",
      status: "failed",
      error: "notification failed: lark: lark unavailable",
    });
  });

  it("builds a repair requirement that states the problem before asking for fixes", () => {
    const prompt = buildDailyAuditRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      items: [
        {
          taskId: "loop:geo:bug-fix:1",
          source: "loop-engineering",
          name: "geo bug-fix",
          scheduledAt: 1,
          status: "failed",
          error: "invalid-output",
          failureKind: "invalid-final-summary",
          repairStatus: "pending",
          updatedAt: 2,
        },
      ],
    });

    expect(prompt).toContain("Problem statement:");
    expect(prompt).toContain("The daily task audit found 1 unresolved scheduled task");
    expect(prompt).toContain("Review and confirmation gate:");
    expect(prompt).toContain("For each item, first write the concrete problem statement");
    expect(prompt).toContain("Do not edit code until the failure is independently confirmed");
    expect(prompt).toContain("pre-mutation review");
    expect(prompt).toContain("post-mutation review");
    expect(prompt).toContain("deterministic gates remain authoritative");
    expect(prompt).toContain("loop:geo:bug-fix:1");
  });

  it("dispatches built-in repair through active delegated work order", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-delegate-"));
    const result = await dispatchDailyTaskRepair(
      {
        config: {
          projectSessionPrefix: "tmux_proj_",
          taskAudit: {
            repairWorktreeIsolation: "isolated",
          },
          loopEngineering: {
            supervisor: {
              enabled: true,
              poolSize: 1,
            },
          },
        },
      } as never,
      {
        repoPath: "/repo/tmux-claude-bot",
        repairBranch: "dev",
        items: [
          {
            taskId: "loop:self:1",
            source: "loop-engineering",
            name: "self",
            scheduledAt: 1,
            status: "failed",
            error: "missing output",
            repairStatus: "pending",
            updatedAt: 2,
          },
        ],
      },
    );

    expect(result).toMatchObject({
      status: "queued",
      detail: expect.stringContaining("runId=repair-run-1"),
    });
    expect(startActiveDelegatedTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        session: expect.stringMatching(/^tmux_proj_/),
        requirement: expect.stringContaining("Daily scheduled task audit repair."),
        resourceTrigger: "background",
      }),
    );
  });
});
