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
  it("reports due projects without advancing completion anchors", () => {
    const config = parseLoopConfigYaml(configText);
    const lastFired: Record<string, number> = {};
    const now = Date.parse("2026-07-16T10:10:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired,
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
    expect(lastFired).toEqual({});
  });

  it("does not repeat projects whose anchor is already current", () => {
    const config = parseLoopConfigYaml(configText);
    const now = Date.parse("2026-07-16T10:10:00Z");
    const lastFired: Record<string, number> = { due: now };

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired,
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
    });

    expect(summary.due).toBe(1);
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      scheduledAt,
    });
    expect(lastFired).toEqual({});
  });

  it("collapses stale anchors to the latest due fire instead of replaying missed days", () => {
    const config = parseLoopConfigYaml(configText.replace('"*/5 * * * *"', '"0 10 * * *"'));
    const lastFired: Record<string, number> = {
      due: Date.parse("2026-07-25T10:00:00Z"),
    };
    const latestDue = Date.parse("2026-07-28T10:00:00Z");
    const now = Date.parse("2026-07-28T11:00:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired,
    });

    expect(summary.due).toBe(1);
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      scheduledAt: latestDue,
    });
  });

  it("schedules pull request review jobs independently from architecture jobs", () => {
    const config = parseLoopConfigYaml(
      configText.replace(
        "assessment:\n      command: npm run assess",
        [
          "assessment:",
          "      command: npm run assess",
          "    runner:",
          "      kind: agent-supervised",
          "    pullRequest:",
          "      enabled: true",
          "    pullRequestReview:",
          "      enabled: true",
          '      schedule: "30 11 * * *"',
          "      autoMerge: true",
        ].join("\n"),
      ),
    );
    const now = Date.parse("2026-07-16T11:35:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired: {
        due: Date.parse("2026-07-16T11:35:00Z"),
      },
    });

    expect(summary.due).toBe(1);
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      jobKey: "due:pull-request-review",
      jobKind: "pull-request-review",
      scheduledAt: Date.parse("2026-07-16T11:30:00Z"),
    });
  });

  it("schedules bug-fix jobs independently from architecture jobs", () => {
    const config = parseLoopConfigYaml(
      configText.replace(
        "assessment:\n      command: npm run assess",
        [
          "assessment:",
          "      command: npm run assess",
          "    runner:",
          "      kind: agent-supervised",
          "    bugFix:",
          "      enabled: true",
          '      schedule: "45 11 * * *"',
          "      maxRounds: 2",
          "      maxBugsPerRound: 1",
        ].join("\n"),
      ),
    );
    const now = Date.parse("2026-07-16T11:50:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired: {
        due: Date.parse("2026-07-16T11:50:00Z"),
      },
    });

    expect(summary.due).toBe(1);
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      jobKey: "due:bug-fix",
      jobKind: "bug-fix",
      scheduledAt: Date.parse("2026-07-16T11:45:00Z"),
    });
  });

  it("schedules test-coverage jobs independently from architecture jobs", () => {
    const config = parseLoopConfigYaml(
      configText.replace(
        "assessment:\n      command: npm run assess",
        [
          "assessment:",
          "      command: npm run assess",
          "    runner:",
          "      kind: agent-supervised",
          "    testCoverage:",
          "      enabled: true",
          '      schedule: "20 14 * * *"',
          "      branch: loop/due/test-coverage",
          "      targetCoverage: 80",
          "      maxRounds: 5",
        ].join("\n"),
      ),
    );
    const now = Date.parse("2026-07-16T14:25:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired: {
        due: Date.parse("2026-07-16T14:25:00Z"),
      },
    });

    expect(summary.due).toBe(1);
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      jobKey: "due:test-coverage",
      jobKind: "test-coverage",
      scheduledAt: Date.parse("2026-07-16T14:20:00Z"),
    });
  });

  it("schedules security-maintenance jobs independently from architecture jobs", () => {
    const config = parseLoopConfigYaml(
      configText.replace(
        "assessment:\n      command: npm run assess",
        [
          "assessment:",
          "      command: npm run assess",
          "    runner:",
          "      kind: agent-supervised",
          "    securityMaintenance:",
          "      enabled: true",
          '      schedule: "10 16 * * *"',
          "      branch: loop/due/security-maintenance",
          "      maxRounds: 3",
        ].join("\n"),
      ),
    );
    const now = Date.parse("2026-07-16T16:15:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired: {
        due: Date.parse("2026-07-16T16:15:00Z"),
      },
    });

    expect(summary.due).toBe(1);
    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      jobKey: "due:security-maintenance",
      jobKind: "security-maintenance",
      scheduledAt: Date.parse("2026-07-16T16:10:00Z"),
    });
  });

  it("counts architecture and pull request review as separate checked jobs", () => {
    const config = parseLoopConfigYaml(
      configText.replace(
        "assessment:\n      command: npm run assess",
        [
          "assessment:",
          "      command: npm run assess",
          "    runner:",
          "      kind: agent-supervised",
          "    pullRequest:",
          "      enabled: true",
          "    pullRequestReview:",
          "      enabled: true",
          '      schedule: "30 11 * * *"',
        ].join("\n"),
      ),
    );

    const summary = runLoopSchedulerTick({
      config,
      now: Date.parse("2026-07-16T11:35:00Z"),
      lastFired: {},
    });

    expect(summary.checked).toBe(3);
  });

  it("counts architecture and bug-fix as separate checked jobs", () => {
    const config = parseLoopConfigYaml(
      configText.replace(
        "assessment:\n      command: npm run assess",
        [
          "assessment:",
          "      command: npm run assess",
          "    runner:",
          "      kind: agent-supervised",
          "    bugFix:",
          "      enabled: true",
          '      schedule: "45 11 * * *"',
        ].join("\n"),
      ),
    );

    const summary = runLoopSchedulerTick({
      config,
      now: Date.parse("2026-07-16T11:50:00Z"),
      lastFired: {},
    });

    expect(summary.checked).toBe(3);
  });

  it("counts architecture and test-coverage as separate checked jobs", () => {
    const config = parseLoopConfigYaml(
      configText.replace(
        "assessment:\n      command: npm run assess",
        [
          "assessment:",
          "      command: npm run assess",
          "    runner:",
          "      kind: agent-supervised",
          "    testCoverage:",
          "      enabled: true",
          '      schedule: "20 14 * * *"',
        ].join("\n"),
      ),
    );

    const summary = runLoopSchedulerTick({
      config,
      now: Date.parse("2026-07-16T14:25:00Z"),
      lastFired: {},
    });

    expect(summary.checked).toBe(3);
  });

  it("schedules repository-wide pull request review jobs", () => {
    const config = parseLoopConfigYaml(`${configText}
prReview:
  repositories:
    - id: janitor
      name: PR Janitor
      path: /repo/janitor
      repo: OctopusGarage/janitor
      agent: codex
      schedule: "30 11 * * *"
      base: dev
      autoMerge: true
`);
    const now = Date.parse("2026-07-16T11:35:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired: {},
    });

    expect(summary.checked).toBe(3);
    expect(summary.dueProjects).toContainEqual(
      expect.objectContaining({
        projectId: "janitor",
        jobKey: "pr-review:janitor",
        jobKind: "repository-pull-request-review",
        scheduledAt: Date.parse("2026-07-16T11:30:00Z"),
      }),
    );
  });

  it("schedules workspace architecture jobs as one multi-repository target", () => {
    const config = parseLoopConfigYaml(`${configText}
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
    architecture:
      enabled: true
      schedule: "30 11 * * *"
      goal: Improve frontend/backend architecture together.
`);
    const now = Date.parse("2026-07-16T11:35:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now,
      lastFired: {},
    });

    expect(summary.checked).toBe(3);
    expect(summary.dueProjects).toContainEqual(
      expect.objectContaining({
        projectId: "geo",
        name: "Geo Workspace",
        jobKey: "workspace:geo:architecture",
        jobKind: "workspace-architecture",
        scheduledAt: Date.parse("2026-07-16T11:30:00Z"),
      }),
    );
  });

  it("uses architecture jitter defaults for workspace architecture jobs", () => {
    const config = parseLoopConfigYaml(`scheduler:
  jitter:
    enabled: true
    seed: local-stable
    architectureMaxDelayMinutes: 10
${configText}
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
    architecture:
      enabled: true
      schedule: "10 10 * * *"
      goal: Improve frontend/backend architecture together.
      scheduleJitterMinutes: 0
`);
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");

    const summary = runLoopSchedulerTick({
      config,
      now: scheduledAt,
      lastFired: {
        "workspace:geo:architecture": Date.parse("2026-07-16T10:05:00Z"),
      },
    });

    expect(summary.dueProjects).toContainEqual(
      expect.objectContaining({
        projectId: "geo",
        jobKind: "workspace-architecture",
        scheduledAt,
        effectiveAt: scheduledAt,
        jitterMs: 0,
      }),
    );
  });

  it("delays due jobs until their deterministic jitter effective time", () => {
    const config = parseLoopConfigYaml(`scheduler:
  jitter:
    enabled: true
    seed: local-stable
    architectureMaxDelayMinutes: 10
${configText}`);
    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    const beforeJitter = scheduledAt + 60_000;
    const afterJitter = scheduledAt + 180_000;

    const early = runLoopSchedulerTick({
      config,
      now: beforeJitter,
      lastFired: {
        due: Date.parse("2026-07-16T10:05:00Z"),
      },
    });
    const due = runLoopSchedulerTick({
      config,
      now: afterJitter,
      lastFired: {
        due: Date.parse("2026-07-16T10:05:00Z"),
      },
    });

    expect(early.due).toBe(0);
    expect(early.skipped).toContainEqual(
      expect.objectContaining({
        projectId: "due",
        reason: "not-due",
        scheduledAt,
        jitterMs: expect.any(Number),
        effectiveAt: expect.any(Number),
      }),
    );
    expect(early.skipped.find((item) => item.projectId === "due")?.effectiveAt).toBeGreaterThan(
      beforeJitter,
    );
    expect(due.due).toBe(1);
    expect(due.dueProjects[0]).toMatchObject({
      projectId: "due",
      scheduledAt,
      effectiveAt: early.skipped.find((item) => item.projectId === "due")?.effectiveAt,
      jitterMs: early.skipped.find((item) => item.projectId === "due")?.jitterMs,
    });
  });

  it("does not miss the first scheduled fire when startup happens inside the jitter window", () => {
    const config = parseLoopConfigYaml(`scheduler:
  jitter:
    enabled: true
    seed: local-stable
    architectureMaxDelayMinutes: 30
projects:
  - id: due
    name: Due
    path: /repo/due
    agent: codex
    schedule: "0 10 * * *"
    goal: Improve due project.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
`);
    const scheduledAt = Date.parse("2026-07-16T10:00:00Z");
    const firstStartup = scheduledAt + 20 * 60_000;
    const summary = runLoopSchedulerTick({
      config,
      now: firstStartup,
      lastFired: {},
    });

    const delayed = summary.skipped.find((item) => item.projectId === "due");
    if (summary.due === 0) {
      expect(delayed).toMatchObject({
        reason: "not-due",
        scheduledAt,
        effectiveAt: expect.any(Number),
        jitterMs: expect.any(Number),
      });
      expect(delayed?.effectiveAt).toBeGreaterThan(firstStartup);
    } else {
      expect(summary.dueProjects[0]).toMatchObject({
        projectId: "due",
        scheduledAt,
      });
    }
  });

  it("uses per-job jitter overrides before global defaults", () => {
    const config = parseLoopConfigYaml(
      configText
        .replace(
          'schedule: "*/5 * * * *"',
          ['schedule: "*/5 * * * *"', "    scheduleJitterMinutes: 0"].join("\n"),
        )
        .replace(
          "projects:",
          [
            "scheduler:",
            "  jitter:",
            "    enabled: true",
            "    seed: local-stable",
            "    architectureMaxDelayMinutes: 10",
            "projects:",
          ].join("\n"),
        ),
    );

    const scheduledAt = Date.parse("2026-07-16T10:10:00Z");
    const summary = runLoopSchedulerTick({
      config,
      now: scheduledAt,
      lastFired: {
        due: Date.parse("2026-07-16T10:05:00Z"),
      },
    });

    expect(summary.dueProjects[0]).toMatchObject({
      projectId: "due",
      scheduledAt,
      effectiveAt: scheduledAt,
      jitterMs: 0,
    });
  });
});
