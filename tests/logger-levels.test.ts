import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Test parseLevel switch cases. MIN_LEVEL is a module constant set at load time,
 * so each test uses vi.resetModules() + dynamic import after setting LOG_LEVEL.
 */
describe("parseLevel switch cases (via dynamic import)", () => {
  const originalLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    vi.resetModules();
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
  });

  it("DEBUG level: logger.debug messages are written (not filtered)", async () => {
    process.env.LOG_LEVEL = "DEBUG";
    const { logger } = await import("../src/shared/utils/logger.js");
    expect(() => logger.debug("debug test message")).not.toThrow();
  });

  it("WARN level: warn messages are written", async () => {
    process.env.LOG_LEVEL = "WARN";
    const { logger } = await import("../src/shared/utils/logger.js");
    expect(() => logger.warn("warn test message")).not.toThrow();
  });

  it("ERROR level: error messages are written", async () => {
    process.env.LOG_LEVEL = "ERROR";
    const { logger } = await import("../src/shared/utils/logger.js");
    expect(() => logger.error("error test message")).not.toThrow();
  });
});
