import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

const base = { TELEGRAM_BOT_TOKEN: "t" };

describe("loadConfig lark", () => {
  it("leaves lark undefined when disabled", () => {
    const cfg = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.lark).toBeUndefined();
  });

  it("leaves lark undefined when enabled but credentials missing", () => {
    const cfg = loadConfig({ ...base, LARK_ENABLED: "true" } as NodeJS.ProcessEnv);
    expect(cfg.lark).toBeUndefined();
  });

  it("populates lark when enabled with credentials", () => {
    const cfg = loadConfig({
      ...base,
      LARK_ENABLED: "true",
      LARK_APP_ID: "cli_x",
      LARK_APP_SECRET: "secret_x",
      LARK_ALLOWED_OPEN_IDS: "ou_a, ou_b",
      LARK_DOMAIN: "lark",
    } as NodeJS.ProcessEnv);
    expect(cfg.lark).toEqual({
      appId: "cli_x",
      appSecret: "secret_x",
      allowedOpenIds: new Set(["ou_a", "ou_b"]),
      domain: "lark",
    });
  });
});
