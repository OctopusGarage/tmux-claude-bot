import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/shared/utils/logger.js";
import { timeApi } from "../src/shared/utils/timing.js";

describe("timeApi", () => {
  it("returns the wrapped call's result", async () => {
    const r = await timeApi("getMe", () => Promise.resolve(42));
    expect(r).toBe(42);
  });

  it("logs an info line with the label and a dur_ms field on success", async () => {
    await timeApi("sendMessage", () => Promise.resolve("ok"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("sendMessage"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("dur_ms="));
  });

  it("logs a warn with dur_ms and rethrows on failure", async () => {
    const boom = new Error("ECONNRESET");
    await expect(timeApi("answerCallbackQuery", () => Promise.reject(boom))).rejects.toThrow(
      "ECONNRESET",
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("answerCallbackQuery"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("dur_ms="));
  });
});
