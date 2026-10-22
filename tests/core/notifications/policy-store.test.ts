import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotificationPolicyStore } from "../../../src/core/notifications/policy-store.js";

describe("NotificationPolicyStore", () => {
  it("persists successful state fingerprints across store instances", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-notification-policy-"));
    const store = new NotificationPolicyStore({ stateDir, now: () => 1_000 });

    expect(store.shouldDeliver("power:wake", "missing", "telegram", true)).toBe(true);
    store.recordDelivered("power:wake", "missing", "telegram");

    const restored = new NotificationPolicyStore({ stateDir, now: () => 2_000 });
    expect(restored.shouldDeliver("power:wake", "missing", "telegram", true)).toBe(false);
    expect(restored.shouldDeliver("power:wake", "verified", "telegram", false)).toBe(true);
  });

  it("does not emit an initial recovery without a delivered unhealthy state", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-notification-policy-"));
    const store = new NotificationPolicyStore({ stateDir, now: () => 1_000 });

    expect(store.shouldDeliver("resource:pressure", "healthy", "lark", false)).toBe(false);
  });

  it("fails open when durable policy state is corrupt", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-notification-policy-"));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "notification-policy.json"), "not-json");

    const store = new NotificationPolicyStore({ stateDir, now: () => 1_000 });
    expect(store.shouldDeliver("power:wake", "missing", "telegram", true)).toBe(true);
  });

  it("expires stale suppression records", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-notification-policy-"));
    let now = Date.parse("2026-08-01T00:00:00Z");
    const store = new NotificationPolicyStore({ stateDir, now: () => now });
    store.recordDelivered("resource:pressure", "critical", "telegram");
    now += 31 * 24 * 60 * 60_000;

    expect(store.shouldDeliver("resource:pressure", "critical", "telegram", true)).toBe(true);
  });
});
