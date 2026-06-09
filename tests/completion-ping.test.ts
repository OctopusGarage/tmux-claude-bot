import { describe, expect, it } from "vitest";
import { shouldSendCompletionPing } from "../src/adapters/telegram/prompt-lifecycle.js";

describe("shouldSendCompletionPing", () => {
  it("does not ping for quick tasks", () => {
    expect(shouldSendCompletionPing(0)).toBe(false);
    expect(shouldSendCompletionPing(59)).toBe(false);
  });

  it("does not ping at exactly the 60s threshold (only when it exceeds it)", () => {
    expect(shouldSendCompletionPing(60)).toBe(false);
  });

  it("pings once a task runs longer than 60s — the user has likely walked away", () => {
    expect(shouldSendCompletionPing(61)).toBe(true);
    expect(shouldSendCompletionPing(600)).toBe(true);
  });
});
