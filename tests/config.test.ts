import { describe, expect, it } from "vitest";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  CLAUDE_START_COMMAND: z.string().min(1).default("claude-yolo"),
  IDLE_POLL_TICKS: z.coerce.number().int().positive().default(3),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  MAX_OUTPUT_LINES: z.coerce.number().int().positive().default(200),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(3500),
  RATE_LIMIT_MS: z.coerce.number().int().positive().default(2000),
  SESSION_WARMUP_MS: z.coerce.number().int().positive().default(500),
  MAX_QUEUE_SIZE: z.coerce.number().int().positive().default(10),
  MAX_WAIT_READY_MS: z.coerce.number().int().positive().default(60000),
  MAX_WAIT_DONE_MS: z.coerce.number().int().positive().default(300000),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  CD_ALLOWED_DIRS: z.string().default(""),
  PROJECT_SESSION_PREFIX: z.string().min(1).default("tmux_proj_"),
});

describe("config schema", () => {
  it("uses defaults when env vars are empty", () => {
    const env = { TELEGRAM_BOT_TOKEN: "test-token" };
    const parsed = envSchema.parse(env);
    expect(parsed.CLAUDE_START_COMMAND).toBe("claude-yolo");
    expect(parsed.IDLE_POLL_TICKS).toBe(3);
    expect(parsed.PROJECT_SESSION_PREFIX).toBe("tmux_proj_");
    expect(parsed.RATE_LIMIT_MS).toBe(2000);
    expect(parsed.SESSION_WARMUP_MS).toBe(500);
    expect(parsed.MAX_QUEUE_SIZE).toBe(10);
    expect(parsed.MAX_WAIT_READY_MS).toBe(60000);
    expect(parsed.MAX_WAIT_DONE_MS).toBe(300000);
  });

  it("parses PROJECT_SESSION_PREFIX from env", () => {
    const env = { TELEGRAM_BOT_TOKEN: "test-token", PROJECT_SESSION_PREFIX: "custom_proj_" };
    const parsed = envSchema.parse(env);
    expect(parsed.PROJECT_SESSION_PREFIX).toBe("custom_proj_");
  });

  it("parses TELEGRAM_ALLOWED_USER_IDS comma-separated list", () => {
    const env = { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_ALLOWED_USER_IDS: "123, 456, 789" };
    const parsed = envSchema.parse(env);
    expect(parsed.TELEGRAM_ALLOWED_USER_IDS).toBe("123, 456, 789");
  });

  it("parses CD_ALLOWED_DIRS comma-separated list", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "test-token",
      CD_ALLOWED_DIRS: "/home/user/projects,/home/user/work",
    };
    const parsed = envSchema.parse(env);
    expect(parsed.CD_ALLOWED_DIRS).toBe("/home/user/projects,/home/user/work");
  });

  it("requires TELEGRAM_BOT_TOKEN", () => {
    expect(() => envSchema.parse({})).toThrow();
  });

  it("coerces numeric strings to numbers", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "test-token",
      IDLE_POLL_TICKS: "5",
      POLL_INTERVAL_MS: "2000",
    };
    const parsed = envSchema.parse(env);
    expect(parsed.IDLE_POLL_TICKS).toBe(5);
    expect(parsed.POLL_INTERVAL_MS).toBe(2000);
  });

  it("parses all new timing configs", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "test-token",
      RATE_LIMIT_MS: "3000",
      SESSION_WARMUP_MS: "1000",
      MAX_QUEUE_SIZE: "5",
      MAX_WAIT_READY_MS: "30000",
      MAX_WAIT_DONE_MS: "60000",
    };
    const parsed = envSchema.parse(env);
    expect(parsed.RATE_LIMIT_MS).toBe(3000);
    expect(parsed.SESSION_WARMUP_MS).toBe(1000);
    expect(parsed.MAX_QUEUE_SIZE).toBe(5);
    expect(parsed.MAX_WAIT_READY_MS).toBe(30000);
    expect(parsed.MAX_WAIT_DONE_MS).toBe(60000);
  });
});

import { loadConfig, loadScriptConfig } from "../src/shared/config.js";

describe("autoRecover config", () => {
  it("defaults to true (auto-recover on boot)", () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t" }).autoRecover).toBe(true);
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t", AUTO_RECOVER: "" }).autoRecover).toBe(true);
  });
  it("is disabled by false / 0", () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t", AUTO_RECOVER: "false" }).autoRecover).toBe(false);
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t", AUTO_RECOVER: "0" }).autoRecover).toBe(false);
  });
});

describe("loadScriptConfig without args", () => {
  it("reads from process.env and returns a valid config", () => {
    // Sets CLAUDE_START_COMMAND so the schema doesn't fail.
    const saved = process.env.CLAUDE_START_COMMAND;
    process.env.CLAUDE_START_COMMAND = "claude-yolo";
    try {
      const cfg = loadScriptConfig();
      expect(cfg).toHaveProperty("claudeStartCommand");
      expect(cfg.projectSessionPrefix).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_START_COMMAND;
      else process.env.CLAUDE_START_COMMAND = saved;
    }
  });
});

describe("loadConfig (real schema)", () => {
  it("a blank/invalid LARK_DOMAIN falls back to feishu instead of crashing", () => {
    // A stray `LARK_DOMAIN=` line must not take down a Telegram-only install.
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: "t", LARK_ENABLED: "false", LARK_DOMAIN: "" }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: "t", LARK_ENABLED: "false", LARK_DOMAIN: "garbage" }),
    ).not.toThrow();
  });

  it("a blank numeric env var falls back to its default instead of crashing", () => {
    // `POLL_INTERVAL_MS=` (empty) makes dotenv inject "", which is *present* — a
    // plain `.default()` would be skipped and `.positive()` would reject the
    // coerced 0, taking down startup with a cryptic ZodError.
    const cfg = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      POLL_INTERVAL_MS: "",
      IDLE_POLL_TICKS: "",
      MAX_WAIT_DONE_TOTAL_MS: "",
    });
    expect(cfg.pollIntervalMs).toBe(1000);
    expect(cfg.idlePollTicks).toBe(5);
    expect(cfg.maxWaitDoneTotalMs).toBe(3600000);
  });

  it("configures session idle reaping with conservative defaults and explicit disable", () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t" }).sessionIdleReaper).toEqual({
      tickMs: 3_600_000,
      maxIdleMs: 259_200_000,
      loopWorkerMaxIdleMs: 21_600_000,
    });
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: "t",
        SESSION_IDLE_REAPER_TICK_MS: "",
        SESSION_IDLE_REAPER_MAX_IDLE_MS: "",
        SESSION_IDLE_REAPER_LOOP_WORKER_MAX_IDLE_MS: "",
      }).sessionIdleReaper,
    ).toEqual({ tickMs: 3_600_000, maxIdleMs: 259_200_000, loopWorkerMaxIdleMs: 21_600_000 });
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: "t",
        SESSION_IDLE_REAPER_TICK_MS: "0",
        SESSION_IDLE_REAPER_MAX_IDLE_MS: "0",
        SESSION_IDLE_REAPER_LOOP_WORKER_MAX_IDLE_MS: "0",
      }).sessionIdleReaper,
    ).toEqual({ tickMs: 0, maxIdleMs: 0, loopWorkerMaxIdleMs: 0 });
  });

  it("a non-empty but non-numeric env var still throws (a real typo)", () => {
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", POLL_INTERVAL_MS: "abc" })).toThrow();
  });
});
