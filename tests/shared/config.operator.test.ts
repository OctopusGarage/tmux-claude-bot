import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

const base = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: "1" };

describe("homeOperator config", () => {
  it("defaults to disabled, claude, empty dir", () => {
    const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(c.homeOperator).toEqual({ enabled: false, dir: "", agent: "claude" });
  });
  it("blank HOME_OPERATOR_ENABLED stays disabled", () => {
    const c = loadConfig({ ...base, HOME_OPERATOR_ENABLED: "" } as NodeJS.ProcessEnv);
    expect(c.homeOperator.enabled).toBe(false);
  });
  it("HOME_OPERATOR_ENABLED=0 stays disabled", () => {
    const c = loadConfig({ ...base, HOME_OPERATOR_ENABLED: "0" } as NodeJS.ProcessEnv);
    expect(c.homeOperator.enabled).toBe(false);
  });
  it("enables and honours dir + agent", () => {
    const c = loadConfig({
      ...base,
      HOME_OPERATOR_ENABLED: "true",
      HOME_OPERATOR_DIR: "/home/user/op",
      HOME_OPERATOR_AGENT: "codex",
    } as NodeJS.ProcessEnv);
    expect(c.homeOperator).toEqual({ enabled: true, dir: "/home/user/op", agent: "codex" });
  });
});

describe("loop supervisor config", () => {
  it("defaults to disabled, codex, empty dir", () => {
    const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(c.loopEngineering.supervisor).toEqual({
      enabled: false,
      dir: "",
      agent: "codex",
      poolSize: 1,
      resetBeforeWorkOrder: "clear",
      worktreeIsolation: "isolated",
    });
  });

  it("blank LOOP_SUPERVISOR_ENABLED stays disabled", () => {
    const c = loadConfig({ ...base, LOOP_SUPERVISOR_ENABLED: "" } as NodeJS.ProcessEnv);
    expect(c.loopEngineering.supervisor.enabled).toBe(false);
  });

  it("LOOP_SUPERVISOR_ENABLED=0 stays disabled", () => {
    const c = loadConfig({ ...base, LOOP_SUPERVISOR_ENABLED: "0" } as NodeJS.ProcessEnv);
    expect(c.loopEngineering.supervisor.enabled).toBe(false);
  });

  it("enables and honours dir + agent", () => {
    const c = loadConfig({
      ...base,
      LOOP_SUPERVISOR_ENABLED: "true",
      LOOP_SUPERVISOR_DIR: "/workspace/loop-supervisor",
      LOOP_SUPERVISOR_AGENT: "claude",
      LOOP_SUPERVISOR_POOL_SIZE: "3",
      LOOP_SUPERVISOR_RESET_BEFORE_WORK_ORDER: "compact",
      LOOP_SUPERVISOR_WORKTREE_ISOLATION: "source",
    } as NodeJS.ProcessEnv);
    expect(c.loopEngineering.supervisor).toEqual({
      enabled: true,
      dir: "/workspace/loop-supervisor",
      agent: "claude",
      poolSize: 3,
      resetBeforeWorkOrder: "compact",
      worktreeIsolation: "source",
    });
  });
});
