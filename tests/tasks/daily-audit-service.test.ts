import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationGateway } from "../../src/core/notifications/gateway.js";
import { runDailyTaskAuditServiceTick } from "../../src/core/tasks/daily-audit-service.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("runDailyTaskAuditServiceTick", () => {
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
      },
      notifications,
      ledger,
      discover: () => [],
    });

    expect(first).toMatchObject({ fired: true });
    expect(second).toMatchObject({ fired: false, reason: "not-due" });
    expect(send).toHaveBeenCalledTimes(1);
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
      },
      notifications,
      discover: () => [],
    });

    expect(result).toMatchObject({
      fired: true,
      scheduledAt: Date.parse("2026-07-28T02:00:00Z"),
    });
    expect(send).toHaveBeenCalledTimes(1);
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
      },
      notifications,
      ledger,
      dispatchRepair,
      discover: () => [],
    });

    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        repairBranch: "dev",
        items: [expect.objectContaining({ taskId: "radar:daily:failed" })],
      }),
    );
    expect(events[0]).toBe("dispatch");
    expect(events[1]).toContain("repair-dispatch: queued");
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
      },
      notifications,
      ledger,
      dispatchRepair: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      discover: () => [],
    });

    expect(result).toMatchObject({ fired: true, failures: 1 });
    expect(sentMessages[0]).toContain("repair-dispatch: failed");
    expect(
      ledger.listForWindow({
        start: Date.parse("2026-07-28T00:00:00Z"),
        end: Date.parse("2026-07-29T00:00:00Z"),
        label: "2026-07-28 UTC",
      })[0],
    ).toMatchObject({
      status: "success",
      summary: "failures=1 repair-dispatch=failed",
    });
  });

  it("does not mark the audit complete when the final notification cannot be delivered", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-notify-fails-"));
    const notifications = new NotificationGateway();
    const send = vi.fn(async () => {
      throw new Error("lark unavailable");
    });
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
});
