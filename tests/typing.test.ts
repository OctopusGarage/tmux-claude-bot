import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import { startTyping } from "../src/adapters/telegram/typing.js";

describe("startTyping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a typing action immediately", () => {
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };
    startTyping(api, 12345, 4500);
    expect(api.sendChatAction).toHaveBeenCalledWith(12345, "typing");
    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
  });

  it("refreshes the typing action on the interval", () => {
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };
    startTyping(api, 1, 4500);
    vi.advanceTimersByTime(4500);
    expect(api.sendChatAction).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4500);
    expect(api.sendChatAction).toHaveBeenCalledTimes(3);
  });

  it("stops refreshing once the returned stop function is called", () => {
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };
    const stop = startTyping(api, 1, 4500);
    stop();
    vi.advanceTimersByTime(4500 * 5);
    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
  });
});
