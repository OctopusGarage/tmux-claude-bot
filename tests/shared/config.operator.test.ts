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
