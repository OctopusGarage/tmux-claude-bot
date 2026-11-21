import { GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCommandRegistration } from "../../../src/adapters/telegram/command-registration.js";

function apiError(code: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    "registration failed",
    {
      ok: false,
      error_code: code,
      description: "failed",
      parameters: retryAfter === undefined ? {} : { retry_after: retryAfter },
    },
    "setMyCommands",
    {},
  );
}

describe("Telegram command registration recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("backs off transient failures without overlapping or exceeding the normal retry rate", async () => {
    const times: number[] = [];
    const register = vi.fn(async () => {
      times.push(Date.now());
      throw new Error("TLS disconnected");
    });
    const stop = startCommandRegistration(register);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(times).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000]);
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(register).toHaveBeenCalledTimes(8);
  });

  it.each([400, 401, 403, 404])(
    "stops menu retries after permanent API rejection %s",
    async (code) => {
      const register = vi.fn(async () => {
        throw apiError(code);
      });
      const stop = startCommandRegistration(register);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(register).toHaveBeenCalledOnce();
      stop();
    },
  );

  it("honors rate-limit retry_after and stops after successful synchronization", async () => {
    const register = vi.fn().mockRejectedValueOnce(apiError(429, 60)).mockResolvedValue(undefined);
    const stop = startCommandRegistration(register);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(register).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(register).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(register).toHaveBeenCalledTimes(2);
    stop();
  });

  it("retries server failures", async () => {
    const register = vi.fn().mockRejectedValueOnce(apiError(503)).mockResolvedValue(undefined);
    const stop = startCommandRegistration(register);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(register).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not overlap an in-flight request or reschedule its late failure after shutdown", async () => {
    let reject: (error: Error) => void = () => {};
    const register = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const stop = startCommandRegistration(register);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(register).toHaveBeenCalledOnce();
    stop();
    reject(new Error("late transport failure"));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(register).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
