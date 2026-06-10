import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

describe("loadConfig telegram", () => {
  it("reads the prefixed env vars into the telegram* fields", () => {
    const cfg = loadConfig({
      TELEGRAM_BOT_TOKEN: "abc",
      TELEGRAM_ALLOWED_USER_IDS: "1, 2 ,3",
      TELEGRAM_HTTP_PROXY: "http://proxy:8080",
    } as NodeJS.ProcessEnv);
    expect(cfg.telegramBotToken).toBe("abc");
    expect(cfg.telegramAllowedUserIds).toEqual(new Set(["1", "2", "3"]));
    expect(cfg.telegramHttpProxy).toBe("http://proxy:8080");
  });

  it("falls back to the legacy BOT_TOKEN when the prefixed key is absent", () => {
    const cfg = loadConfig({ BOT_TOKEN: "x" } as NodeJS.ProcessEnv);
    expect(cfg.telegramBotToken).toBe("x");
  });

  it("falls back to legacy ALLOWED_USER_IDS and HTTP_PROXY", () => {
    const cfg = loadConfig({
      BOT_TOKEN: "x",
      ALLOWED_USER_IDS: "7,8",
      HTTP_PROXY: "http://legacy:3128",
    } as NodeJS.ProcessEnv);
    expect(cfg.telegramAllowedUserIds).toEqual(new Set(["7", "8"]));
    expect(cfg.telegramHttpProxy).toBe("http://legacy:3128");
  });

  it("prefers the prefixed key over the legacy alias", () => {
    const cfg = loadConfig({
      TELEGRAM_BOT_TOKEN: "new",
      BOT_TOKEN: "old",
    } as NodeJS.ProcessEnv);
    expect(cfg.telegramBotToken).toBe("new");
  });
});
