import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import { logger } from "../src/shared/utils/logger.js";
import { timeApi } from "../src/shared/utils/timing.js";

describe("timeApi", () => {
  it("returns the wrapped call's result", async () => {
    const r = await timeApi("getMe", () => Promise.resolve(42));
    expect(r).toBe(42);
  });

  it("logs structured success timing at debug level", async () => {
    await timeApi("sendMessage", () => Promise.resolve("ok"));
    expect(logger.debug).toHaveBeenCalledWith("external call completed", {
      data: { label: "sendMessage", durationMs: expect.any(Number) },
    });
  });

  it("logs structured failure timing and rethrows", async () => {
    const boom = new Error("ECONNRESET");
    await expect(timeApi("answerCallbackQuery", () => Promise.reject(boom))).rejects.toThrow(
      "ECONNRESET",
    );
    expect(logger.warn).toHaveBeenCalledWith("external call failed", {
      err: boom,
      data: { label: "answerCallbackQuery", durationMs: expect.any(Number) },
    });
  });
});
