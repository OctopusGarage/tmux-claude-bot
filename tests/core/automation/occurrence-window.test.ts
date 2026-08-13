import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationOccurrenceStore } from "../../../src/core/automation/occurrence-window.js";

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-occurrence-window-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("AutomationOccurrenceStore", () => {
  it("persists the first random execution time across a new store instance", () => {
    const first = new AutomationOccurrenceStore({ randomOffset: () => 42 }).plan({
      key: "project-a:architecture",
      scheduledAt: 1_000,
      windowMs: 100,
      now: 1_000,
    });
    const restored = new AutomationOccurrenceStore({ randomOffset: () => 99 }).plan({
      key: "project-a:architecture",
      scheduledAt: 1_000,
      windowMs: 100,
      now: 1_100,
    });

    expect(first.notBefore).toBe(1_042);
    expect(restored).toEqual(first);
  });

  it("uses the exact occurrence time for a zero-width window", () => {
    const occurrence = new AutomationOccurrenceStore({ randomOffset: () => 99 }).plan({
      key: "project-a:test-coverage",
      scheduledAt: 2_000,
      windowMs: 0,
      now: 2_000,
    });

    expect(occurrence.notBefore).toBe(2_000);
  });

  it("bounds a supplied offset to the configured window", () => {
    const occurrence = new AutomationOccurrenceStore({ randomOffset: () => 1_000 }).plan({
      key: "project-a:harness-auto",
      scheduledAt: 3_000,
      windowMs: 100,
      now: 3_000,
    });

    expect(occurrence.notBefore).toBe(3_100);
  });

  it("supersedes older unreserved occurrences for the same key", () => {
    const store = new AutomationOccurrenceStore({ randomOffset: () => 0 });
    const older = store.plan({
      key: "project-a:architecture",
      scheduledAt: 1_000,
      windowMs: 60,
      now: 1_000,
    });
    const latest = store.plan({
      key: "project-a:architecture",
      scheduledAt: 2_000,
      windowMs: 60,
      now: 2_000,
    });

    expect(store.get(older.id)).toMatchObject({ status: "superseded", retainedBy: latest.id });
    expect(store.get(latest.id)).toMatchObject({ status: "planned" });
  });

  it("writes only bounded structured occurrence evidence", () => {
    mkdirSync(join(stateDir, "automation-admission"), { recursive: true });
    new AutomationOccurrenceStore({ randomOffset: () => 0 }).plan({
      key: "project-a:architecture",
      scheduledAt: 1_000,
      windowMs: 60,
      now: 1_000,
    });

    const raw = readFileSync(join(stateDir, "automation-admission", "occurrences.json"), "utf8");
    expect(raw).not.toContain(process.env.HOME ?? "<missing-home>");
    expect(JSON.parse(raw)).toMatchObject({
      "project-a:architecture@1000": {
        schemaVersion: 1,
        status: "planned",
      },
    });
  });

  it("prunes terminal occurrence evidence after its bounded retention window", () => {
    const store = new AutomationOccurrenceStore({ randomOffset: () => 0 });
    const old = store.plan({ key: "loop:old", scheduledAt: 1, windowMs: 0, now: 1 });
    store.setStatus(old.id, "settled", 2);

    const afterRetention = 31 * 24 * 60 * 60_000;
    store.plan({
      key: "loop:new",
      scheduledAt: afterRetention,
      windowMs: 0,
      now: afterRetention,
    });

    expect(store.get(old.id)).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });
});
