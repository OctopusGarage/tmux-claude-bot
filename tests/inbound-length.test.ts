import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";

describe("maxInboundLength config", () => {
  it("defaults to at least Telegram's 4096 single-message limit", () => {
    const cfg = loadConfig({ BOT_TOKEN: "t" } as NodeJS.ProcessEnv);
    expect(cfg.maxInboundLength).toBeGreaterThanOrEqual(4096);
  });

  it("is independent of the outbound truncation limit (maxMessageLength)", () => {
    // A prompt sent TO Claude must not be rejected just because it exceeds the
    // limit used to TRUNCATE replies coming back FROM Claude.
    const cfg = loadConfig({
      BOT_TOKEN: "t",
      MAX_MESSAGE_LENGTH: "3500",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.maxInboundLength).toBeGreaterThan(cfg.maxMessageLength);
  });

  it("parses MAX_INBOUND_LENGTH from env", () => {
    const cfg = loadConfig({
      BOT_TOKEN: "t",
      MAX_INBOUND_LENGTH: "6000",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.maxInboundLength).toBe(6000);
  });
});
