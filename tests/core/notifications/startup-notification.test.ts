import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NotificationGateway } from "../../../src/core/notifications/gateway.js";
import { notifyCrashRecovery } from "../../../src/core/notifications/startup-notification.js";

describe("notifyCrashRecovery", () => {
  it("uses one preferred owner channel and falls back only on failure", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-startup-notification-"));
    const telegram = vi.fn(async (_message: string) => {
      throw new Error("offline");
    });
    const lark = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway({ stateDir });
    gateway.register("telegram", telegram);
    gateway.register("lark", lark);

    await notifyCrashRecovery(gateway, "123 2026-08-13T00:00:00.000Z");
    await notifyCrashRecovery(gateway, "123 2026-08-13T00:00:00.000Z");

    expect(telegram).toHaveBeenCalledTimes(2);
    expect(lark).toHaveBeenCalledTimes(1);
    expect(lark.mock.calls[0]?.[0]).toBe("⚠️ Service recovered\nRecovered after an unclean exit");
  });
});
