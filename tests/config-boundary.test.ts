import { execFileSync } from "node:child_process";
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

  it("parses hourly system self-heal config", () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: "t",
        SYSTEM_SELF_HEAL_ENABLED: "true",
        SYSTEM_SELF_HEAL_TICK_MS: "3600000",
      }).systemSelfHeal,
    ).toEqual({
      enabled: true,
      tickMs: 3_600_000,
    });

    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: "t",
        SYSTEM_SELF_HEAL_ENABLED: "false",
        SYSTEM_SELF_HEAL_TICK_MS: "0",
      }).systemSelfHeal,
    ).toEqual({
      enabled: false,
      tickMs: 0,
    });
  });
});

describe("repository state boundary", () => {
  it("does not version live runtime state", () => {
    const trackedState = execFileSync("git", ["ls-files", "--", "state"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(trackedState).toEqual([]);
  });
});
