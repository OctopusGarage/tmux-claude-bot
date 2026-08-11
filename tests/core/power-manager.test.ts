import { describe, expect, it, vi } from "vitest";
import { createHostPowerManager } from "../../src/core/power/power-manager.js";
import type { HostPowerConfig } from "../../src/shared/types.js";

const scheduled: HostPowerConfig = {
  mode: "scheduled",
  timezone: "Asia/Singapore",
  quietStart: "02:00",
  quietEnd: "09:30",
};
const atSingapore = (iso: string): number => Date.parse(`${iso}+08:00`);

function harness(overrides: Record<string, unknown> = {}) {
  const keepAwake = {
    acquire: vi.fn(() => true),
    release: vi.fn(),
    active: vi.fn(() => false),
    stop: vi.fn(),
  };
  const options = {
    now: () => atSingapore("2026-08-11T04:00:00"),
    keepAwake,
    hasProtectedWork: vi.fn(async () => ({ active: false, reasons: [] })),
    inspectSchedule: vi.fn(() => ({
      status: "verified" as const,
      wakeAt: "09:15",
      timezone: "Asia/Singapore",
      hostWakeAt: "09:15",
      hostTimezone: "Asia/Singapore",
      detail: "exact",
    })),
    readPowerSource: vi.fn(() => "ac" as const),
    notifyDegraded: vi.fn(async () => {}),
    setInterval: vi.fn(() => ({ unref: vi.fn() })),
    clearInterval: vi.fn(),
    ...overrides,
  };
  return { manager: createHostPowerManager(scheduled, options), keepAwake, options };
}

describe("host power manager", () => {
  it("acquires keep-awake throughout service and warmup", async () => {
    for (const iso of ["2026-08-11T12:00:00", "2026-08-11T09:20:00"]) {
      const { manager, keepAwake } = harness({ now: () => atSingapore(iso) });
      await manager.reconcile();
      expect(keepAwake.acquire).toHaveBeenCalledTimes(1);
      expect(keepAwake.release).not.toHaveBeenCalled();
    }
  });

  it("releases during quiet hours only when wake is verified and work is drained", async () => {
    const { manager, keepAwake, options } = harness();
    await manager.reconcile();
    expect(options.hasProtectedWork).toHaveBeenCalledTimes(1);
    expect(options.inspectSchedule).toHaveBeenCalledTimes(1);
    expect(keepAwake.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the assertion for active work and releases after it drains", async () => {
    const hasProtectedWork = vi
      .fn()
      .mockResolvedValueOnce({ active: true, reasons: ["message-queue"] })
      .mockResolvedValueOnce({ active: false, reasons: [] });
    const { manager, keepAwake } = harness({ hasProtectedWork });
    await manager.reconcile();
    expect(keepAwake.acquire).toHaveBeenCalledTimes(1);
    await manager.reconcile();
    expect(keepAwake.release).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "conflict", "dynamic-offset", "error"] as const)(
    "fails awake and notifies once when wake verification is %s",
    async (status) => {
      const notifyDegraded = vi.fn(async () => {});
      const { manager, keepAwake } = harness({
        inspectSchedule: () => ({
          status,
          wakeAt: "09:15",
          timezone: "Asia/Singapore",
          detail: "unsafe to release",
        }),
        notifyDegraded,
      });
      await manager.reconcile();
      await manager.reconcile();
      expect(keepAwake.acquire).toHaveBeenCalledTimes(2);
      expect(keepAwake.release).not.toHaveBeenCalled();
      expect(notifyDegraded).toHaveBeenCalledTimes(1);
    },
  );

  it("reports both wake and AC-only failures when fail-awake runs on battery", async () => {
    const notifyDegraded = vi.fn(async () => {});
    const { manager } = harness({
      readPowerSource: () => "battery",
      inspectSchedule: () => ({
        status: "missing",
        wakeAt: "09:15",
        timezone: "Asia/Singapore",
        hostWakeAt: "09:15",
        hostTimezone: "Asia/Singapore",
        detail: "managed daily wake is not installed",
      }),
      notifyDegraded,
    });
    await manager.reconcile();
    expect(notifyDegraded).toHaveBeenCalledWith(
      "missing: managed daily wake is not installed; host is on battery and the AC-only caffeinate assertion is ineffective",
    );
  });

  it("fails awake when protected-work evidence cannot be read", async () => {
    const notifyDegraded = vi.fn(async () => {});
    const { manager, keepAwake } = harness({
      hasProtectedWork: async () => {
        throw new Error("registry unavailable");
      },
      notifyDegraded,
    });
    await manager.reconcile();
    expect(keepAwake.acquire).toHaveBeenCalledTimes(1);
    expect(notifyDegraded).toHaveBeenCalledWith(expect.stringMatching(/registry unavailable/));
  });

  it("releases in off mode and acquires in always mode", async () => {
    const off = harness();
    const offManager = createHostPowerManager({ ...scheduled, mode: "off" }, off.options);
    await offManager.reconcile();
    expect(off.keepAwake.release).toHaveBeenCalledTimes(1);

    const always = harness();
    const alwaysManager = createHostPowerManager({ ...scheduled, mode: "always" }, always.options);
    await alwaysManager.reconcile();
    expect(always.keepAwake.acquire).toHaveBeenCalledTimes(1);
  });

  it("starts one unrefed timer and stops it with the assertion", async () => {
    const { manager, keepAwake, options } = harness();
    manager.start();
    await Promise.resolve();
    expect(options.setInterval).toHaveBeenCalledTimes(1);
    expect(options.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000);
    manager.stop();
    expect(options.clearInterval).toHaveBeenCalledTimes(1);
    expect(keepAwake.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["off", "always"] as const)("does not poll when %s mode is static", async (mode) => {
    const { keepAwake, options } = harness();
    const manager = createHostPowerManager({ ...scheduled, mode }, options);
    manager.start();
    await Promise.resolve();
    expect(options.setInterval).not.toHaveBeenCalled();
    manager.stop();
    expect(keepAwake.stop).toHaveBeenCalledTimes(1);
  });

  it("reports a failed caffeinate acquisition as degraded", async () => {
    const notifyDegraded = vi.fn(async () => {});
    const { options } = harness({ notifyDegraded });
    options.keepAwake.acquire.mockReturnValue(false);
    const manager = createHostPowerManager(scheduled, {
      ...options,
      now: () => atSingapore("2026-08-11T12:00:00"),
    });
    await manager.reconcile();
    expect(notifyDegraded).toHaveBeenCalledWith("caffeinate assertion could not be acquired");
  });

  it("reports AC-only keep-awake as degraded while the host is on battery", async () => {
    const notifyDegraded = vi.fn(async () => {});
    const { manager, keepAwake } = harness({
      now: () => atSingapore("2026-08-11T12:00:00"),
      readPowerSource: () => "battery",
      notifyDegraded,
    });
    await manager.reconcile();
    expect(keepAwake.acquire).toHaveBeenCalledTimes(1);
    expect(notifyDegraded).toHaveBeenCalledWith(
      "host is on battery; caffeinate -s does not prevent system sleep",
    );
  });
});
