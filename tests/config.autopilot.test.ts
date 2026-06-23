import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";

describe("autopilot config", () => {
  it("defaults: loop on, conservative budgets", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.autopilot.tickMs).toBe(8000);
    expect(cfg.autopilot.idleGraceMs).toBe(20000);
    expect(cfg.autopilot.cooldownMs).toBe(30000);
    expect(cfg.autopilot.maxIterations).toBe(30);
    expect(cfg.autopilot.idlePromptText).toBe("请继续完成当前任务");
    expect(cfg.autopilot.apiErrorPromptText).toContain("重试"); // distinct from the idle nudge
    expect(cfg.autopilot.retry).toEqual({
      maxRetries: 5,
      baseDelayMs: 30000,
      backoffFactor: 2,
      maxDelayMs: 120000,
      jitter: true,
    });
    expect(cfg.autopilot.retryBusy).toEqual({
      maxRetries: 5,
      baseDelayMs: 180000,
      backoffFactor: 2,
      maxDelayMs: 600000,
      jitter: true,
    });
    expect(cfg.autopilot.usagePausePct).toBe(0);
    expect(cfg.autopilot.goalsDir).toBe("");
  });

  it("master off via AUTOPILOT_TICK_MS=0 and overrides parse", () => {
    const cfg = loadConfig({
      AUTOPILOT_TICK_MS: "0",
      AUTOPILOT_RETRY_JITTER: "false",
      AUTOPILOT_IDLE_PROMPT_TEXT: "continue",
      AUTOPILOT_API_ERROR_PROMPT_TEXT: "retry that",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.autopilot.tickMs).toBe(0);
    expect(cfg.autopilot.retry.jitter).toBe(false);
    expect(cfg.autopilot.idlePromptText).toBe("continue");
    expect(cfg.autopilot.apiErrorPromptText).toBe("retry that");
  });

  it("AUTOPILOT_USAGE_PAUSE_PCT=90 parses to 90", () => {
    const cfg = loadConfig({
      AUTOPILOT_USAGE_PAUSE_PCT: "90",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.autopilot.usagePausePct).toBe(90);
  });

  it("autopilot config exposes keep-alive completion + round-cap defaults", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv).autopilot;
    expect(cfg.keepAliveDoneMarker).toBe("TASK_DONE");
    expect(cfg.keepAliveDonePrompt).toContain("TASK_DONE");
    expect(cfg.maxRounds).toBe(10);
  });
});
