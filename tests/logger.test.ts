import { afterEach, describe, expect, it } from "vitest";
import { logger, redactSecrets } from "../src/shared/utils/logger.js";

describe("redactSecrets", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  it("redacts a Bot API token embedded in a fetch error URL", () => {
    const msg =
      "request to https://api.telegram.org/bot8539533731:AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U/getUpdates failed";
    const out = redactSecrets(msg);
    expect(out).not.toContain("AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U");
    expect(out).toContain("bot<redacted-token>");
  });

  it("redacts the exact configured token wherever it appears", () => {
    process.env.TELEGRAM_BOT_TOKEN = "8539533731:AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U";
    const out = redactSecrets("token leaked: 8539533731:AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U end");
    expect(out).toBe("token leaked: <redacted-token> end");
  });

  it("leaves token-free messages untouched", () => {
    const msg = "[smart-fetch] recovered via direct after preferred route failed";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe("logger argsToString branches", () => {
  it("passes Error objects through with message+stack", () => {
    expect(() => logger.info(new Error("boom"))).not.toThrow();
  });

  it("JSON-stringifies plain objects", () => {
    expect(() => logger.info({ key: "value" })).not.toThrow();
  });

  it("falls back to String() for circular (non-serializable) objects", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => logger.warn(circular)).not.toThrow();
  });

  it("calls debug without throwing (exercises the debug log level path)", () => {
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
