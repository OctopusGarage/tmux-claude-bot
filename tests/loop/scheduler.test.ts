import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import { runLoopSchedulerTick } from "../../src/core/loop/scheduler.js";

const configText = `
projects:
  - id: due
    name: Due
    path: /repo/due
    agent: codex
    schedule: "*/5 * * * *"
    goal: Improve due project.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
  - id: manual
    name: Manual
    path: /repo/manual
    agent: claude
    goal: Improve manual project.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
`;

describe("runLoopSchedulerTick", () => {
  it("reports due projects without executing them", () => {
    const config = parseLoopConfigYaml(configText);
    const lastFired: Record<string, number> = {};
    const now = Date.parse("2026-07-16T10:10:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired,
      setLastFired: (projectId, firedAt) => {
        lastFired[projectId] = firedAt;
      },
    });

    expect(summary).toMatchObject({
      phase: "due-only",
      checked: 2,
      scheduled: 1,
      due: 1,
      executed: 0,
      skipped: [{ projectId: "manual", reason: "manual-only" }],
    });
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      name: "Due",
      action: "would-run",
    });
    expect(lastFired.due).toBe(now);
  });

  it("does not repeat projects whose anchor is already current", () => {
    const config = parseLoopConfigYaml(configText);
    const now = Date.parse("2026-07-16T10:10:00Z");
    const lastFired: Record<string, number> = { due: now };

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired,
      setLastFired: (projectId, firedAt) => {
        lastFired[projectId] = firedAt;
      },
    });

    expect(summary.due).toBe(0);
    expect(summary.dueProjects).toEqual([]);
    expect(lastFired.due).toBe(now);
  });

  it("does not backfill ancient missed fires on first start", () => {
    const config = parseLoopConfigYaml(configText.replace('"*/5 * * * *"', '"0 2 * * *"'));
    const lastFired: Record<string, number> = {};
    const now = Date.parse("2026-07-16T10:10:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired,
      setLastFired: (projectId, firedAt) => {
        lastFired[projectId] = firedAt;
      },
    });

    expect(summary.due).toBe(0);
    expect(lastFired).toEqual({});
  });

  it("allows the first service tick to catch a cron fire within the tick window", () => {
    const config = parseLoopConfigYaml(configText.replace('"*/5 * * * *"', '"0 3 * * *"'));
    const lastFired: Record<string, number> = {};
    const scheduledAt = Date.parse("2026-07-16T03:00:00Z");
    const now = Date.parse("2026-07-16T03:05:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired,
      setLastFired: (projectId, firedAt) => {
        lastFired[projectId] = firedAt;
      },
    });

    expect(summary.due).toBe(1);
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      scheduledAt,
    });
    expect(lastFired.due).toBe(scheduledAt);
  });
});
