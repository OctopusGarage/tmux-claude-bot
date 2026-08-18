import { describe, expect, it } from "vitest";
import { shouldIgnoreUncaughtException } from "../src/core/infra/fatal-errors.js";

function abortErrorWithStack(stack: string): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  err.stack = stack;
  return err;
}

describe("shouldIgnoreUncaughtException", () => {
  it("ignores Telegram transport aborts that escape the polling boundary", () => {
    const err = abortErrorWithStack(
      [
        "AbortError: The operation was aborted.",
        "    at fetch (file://~/programming/OctopusGarage/tmux-claude-bot/node_modules/node-fetch/src/index.js:49:9)",
        "    at Object.fetch (~/programming/OctopusGarage/tmux-claude-bot/src/adapters/telegram/start.ts:65:7)",
        "    at <anonymous> (~/programming/OctopusGarage/tmux-claude-bot/src/adapters/telegram/transport/smart-fetch.ts:78:35)",
      ].join("\n"),
    );

    expect(shouldIgnoreUncaughtException(err, false)).toBe(true);
  });

  it("still treats unrelated aborts as fatal outside shutdown", () => {
    const err = abortErrorWithStack(
      [
        "AbortError: The operation was aborted.",
        "    at runTask (~/programming/OctopusGarage/tmux-claude-bot/src/core/tasks/example.ts:10:1)",
      ].join("\n"),
    );

    expect(shouldIgnoreUncaughtException(err, false)).toBe(false);
  });

  it("ignores abort-like errors during shutdown", () => {
    expect(shouldIgnoreUncaughtException(new Error("request aborted"), true)).toBe(true);
  });
});
