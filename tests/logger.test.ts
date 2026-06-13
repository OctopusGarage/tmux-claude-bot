import { afterEach, describe, expect, it } from "vitest";
import { logger, redactSecrets } from "../src/shared/utils/logger.js";

describe("redactSecrets", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  // Synthetic, non-functional fixture: token-shaped enough for the redaction
  // regex (botID:secret) but deliberately not a real Telegram token pattern
  // (secret part is not the 35-char shape secret scanners match on).
  const FAKE_TOKEN = "123456789:THIS_IS_A_FAKE_TEST_TOKEN_NOT_REAL";

  it("redacts a Bot API token embedded in a fetch error URL", () => {
    const msg = `request to https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates failed`;
    const out = redactSecrets(msg);
    expect(out).not.toContain("THIS_IS_A_FAKE_TEST_TOKEN_NOT_REAL");
    expect(out).toContain("bot<redacted-token>");
  });

  it("redacts the exact configured token wherever it appears", () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const out = redactSecrets(`token leaked: ${FAKE_TOKEN} end`);
    expect(out).toBe("token leaked: <redacted-token> end");
  });

  it("leaves token-free messages untouched", () => {
    const msg = "[smart-fetch] recovered via direct after preferred route failed";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe("logger write", () => {
  it("writes info without throwing", () => {
    expect(() => logger.info("test message")).not.toThrow();
  });

  it("writes with context fields without throwing", () => {
    expect(() =>
      logger.info("ctx test", { session: "s1", chatId: "c1", channel: "lark" }),
    ).not.toThrow();
  });

  it("writes warn without throwing", () => {
    expect(() => logger.warn("warn message")).not.toThrow();
  });

  it("calls debug without throwing", () => {
    expect(() => logger.debug("debug message")).not.toThrow();
  });
});

describe("redactSecrets (Lark app secret)", () => {
  it("redacts LARK_APP_SECRET wherever it appears", () => {
    const prev = process.env.LARK_APP_SECRET;
    process.env.LARK_APP_SECRET = "super-secret-feishu-value";
    try {
      const out = redactSecrets("lark error: appSecret=super-secret-feishu-value boom");
      expect(out).not.toContain("super-secret-feishu-value");
      expect(out).toContain("<redacted-token>");
    } finally {
      if (prev === undefined) delete process.env.LARK_APP_SECRET;
      else process.env.LARK_APP_SECRET = prev;
    }
  });
});
