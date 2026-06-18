import { describe, expect, it } from "vitest";
import {
  currentLogContext,
  newTraceId,
  runWithLogContext,
} from "../src/shared/utils/log-context.js";

describe("log-context", () => {
  it("exposes the context inside runWithLogContext", () => {
    runWithLogContext({ traceId: "t_x", channel: "telegram", chatId: 1 }, () => {
      expect(currentLogContext()).toMatchObject({ traceId: "t_x", channel: "telegram", chatId: 1 });
    });
  });

  it("returns {} outside any context", () => {
    expect(currentLogContext()).toEqual({});
  });

  it("nesting MERGES rather than replaces", () => {
    runWithLogContext({ traceId: "t_x" }, () => {
      runWithLogContext({ session: "s1" }, () => {
        expect(currentLogContext()).toMatchObject({ traceId: "t_x", session: "s1" });
      });
    });
  });

  it("preserves the context across awaits", async () => {
    await runWithLogContext({ traceId: "t_y" }, async () => {
      await Promise.resolve();
      expect(currentLogContext().traceId).toBe("t_y");
    });
  });

  it("newTraceId returns a short prefixed id", () => {
    expect(newTraceId()).toMatch(/^t_[0-9a-f]{8}$/);
  });
});
