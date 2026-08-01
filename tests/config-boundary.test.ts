import { describe, expect, it } from "vitest";
import { envSchema, loadConfig } from "../src/shared/config.js";

/**
 * Schema-introspecting boundary test: a blank `KEY=` line crashed startup once
 * (a numeric field used `.default()` instead of tolerating ""). Rather than list
 * the numeric fields by hand, iterate EVERY key the schema knows about and assert
 * that leaving it blank never throws. This auto-covers fields added later: a new
 * numeric var wired with a plain `.default()` will fail this the moment it lands.
 */
const KEYS = Object.keys(envSchema.shape);

describe("no env var crashes startup when left blank", () => {
  for (const key of KEYS) {
    it(`${key}= (blank) loads without throwing`, () => {
      expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", [key]: "" })).not.toThrow();
    });
  }

  it("covers a non-trivial number of keys (guards an empty introspection)", () => {
    expect(KEYS.length).toBeGreaterThan(10);
  });

  it("parses daily task audit config", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TASK_AUDIT_ENABLED: "true",
      TASK_AUDIT_SCHEDULE: "0 2 * * *",
      TASK_AUDIT_TICK_MS: "60000",
      TASK_AUDIT_CHANNEL: "both",
      TASK_AUDIT_AUTO_REPAIR: "true",
      TASK_AUDIT_REPO_PATH: "/repo/tmux-claude-bot",
      TASK_AUDIT_REPAIR_BRANCH: "dev",
      TASK_AUDIT_REPAIR_WORKTREE_ISOLATION: "source",
    });

    expect(config.taskAudit).toEqual({
      enabled: true,
      schedule: "0 2 * * *",
      tickMs: 60000,
      channel: "both",
      autoRepair: true,
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      repairWorktreeIsolation: "source",
    });
  });

  it("parses BATCH_SCHEDULER_* values", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      BATCH_SCHEDULER_TICK_MS: "1234",
      BATCH_SCHEDULER_QUOTA_PCT: "88",
      BATCH_SCHEDULER_REPROBE_MS: "4321",
    });

    expect(config.scheduler).toEqual({
      tickMs: 1234,
      quotaPct: 88,
      reprobeMs: 4321,
    });
  });

  it("uses scheduler defaults when BATCH_SCHEDULER_* values are blank", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      BATCH_SCHEDULER_TICK_MS: "",
      BATCH_SCHEDULER_QUOTA_PCT: "",
      BATCH_SCHEDULER_REPROBE_MS: "",
    });

    expect(config.scheduler).toEqual({
      tickMs: 8000,
      quotaPct: 99,
      reprobeMs: 1_800_000,
    });
  });
});
