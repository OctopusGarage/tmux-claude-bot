import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoopConfig } from "../../src/core/loop/config.js";
import type { LoopJitterJobKind } from "../../src/core/loop/schedule-jitter.js";
import {
  loopScheduleJitterMaxMs,
  loopScheduleJitterMs,
} from "../../src/core/loop/schedule-jitter.js";

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-jitter-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function config(overrides: Partial<LoopConfig["scheduler"]["jitter"]> = {}): LoopConfig {
  return {
    scheduler: {
      jitter: {
        enabled: true,
        seed: "test-seed",
        architectureMaxDelayMinutes: 11,
        bugFixMaxDelayMinutes: 12,
        testCoverageMaxDelayMinutes: 13,
        securityMaintenanceMaxDelayMinutes: 14,
        harnessAutoMaxDelayMinutes: 15,
        opportunityDiscoveryMaxDelayMinutes: 16,
        automationGovernanceReviewMaxDelayMinutes: 17,
        pullRequestReviewMaxDelayMinutes: 18,
        repositoryPullRequestReviewMaxDelayMinutes: 19,
        ...overrides,
      },
    },
    skills: { catalog: [], approved: [] },
    projects: [],
    workspaces: [],
    prReview: { repositories: [] },
  } as LoopConfig;
}

describe("loop schedule jitter", () => {
  it("returns zero jitter when scheduler jitter is disabled", () => {
    const disabled = config({ enabled: false });

    expect(
      loopScheduleJitterMs({
        config: disabled,
        jobKey: "project-a",
        jobKind: "architecture",
        scheduledAt: 1_000,
      }),
    ).toBe(0);
    expect(loopScheduleJitterMaxMs({ config: disabled, jobKind: "architecture" })).toBe(0);
  });

  it.each([
    ["architecture", 11],
    ["workspace-architecture", 11],
    ["bug-fix", 12],
    ["test-coverage", 13],
    ["security-maintenance", 14],
    ["harness-auto", 15],
    ["opportunity-discovery", 16],
    ["automation-governance-review", 17],
    ["pull-request-review", 18],
    ["repository-pull-request-review", 19],
  ] satisfies Array<[LoopJitterJobKind, number]>)(
    "uses the configured default delay for %s jobs",
    (jobKind, minutes) => {
      expect(loopScheduleJitterMaxMs({ config: config(), jobKind })).toBe(minutes * 60_000);
    },
  );

  it("lets a job-specific jitter override the task-family default", () => {
    expect(
      loopScheduleJitterMaxMs({
        config: config(),
        jobKind: "test-coverage",
        scheduleJitterMinutes: 3,
      }),
    ).toBe(180_000);
  });

  it("clamps negative job-specific jitter to zero", () => {
    const maxMs = loopScheduleJitterMaxMs({
      config: config(),
      jobKind: "test-coverage",
      scheduleJitterMinutes: -5,
    });

    expect(maxMs).toBe(0);
    expect(
      loopScheduleJitterMs({
        config: config(),
        jobKey: "project-a:test-coverage",
        jobKind: "test-coverage",
        scheduledAt: 1_000,
        scheduleJitterMinutes: -5,
      }),
    ).toBe(0);
  });

  it("persists a stable jitter within the allowed max delay", () => {
    const input = {
      config: config(),
      jobKey: "project-a:test-coverage",
      jobKind: "test-coverage" as const,
      scheduledAt: Date.parse("2026-08-08T08:00:00Z"),
    };

    const first = loopScheduleJitterMs(input);
    const second = loopScheduleJitterMs(input);

    expect(second).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(loopScheduleJitterMaxMs(input));
    const stateFile = join(stateDir, "automation-admission", "occurrences.json");
    expect(existsSync(stateFile)).toBe(true);
    expect(readFileSync(stateFile, "utf8")).toContain("project-a:test-coverage");
  });
});
