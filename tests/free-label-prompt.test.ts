import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFreeLabel,
  consumeFreeLabel,
  isAwaitingFreeLabel,
  requestFreeLabel,
} from "../src/core/projects/free-label-prompt.js";

afterEach(() => vi.useRealTimers());

describe("free-label prompt capture", () => {
  it("is not awaiting until requested", () => {
    expect(isAwaitingFreeLabel("telegram:99")).toBe(false);
  });

  it("awaits after request and stops after consume", () => {
    requestFreeLabel("telegram:1");
    expect(isAwaitingFreeLabel("telegram:1")).toBe(true);
    expect(consumeFreeLabel("telegram:1")).toBe(true);
    expect(isAwaitingFreeLabel("telegram:1")).toBe(false);
    // consuming again reports not-live
    expect(consumeFreeLabel("telegram:1")).toBe(false);
  });

  it("is per-scope", () => {
    requestFreeLabel("telegram:1");
    expect(isAwaitingFreeLabel("telegram:2")).toBe(false);
  });

  it("clearFreeLabel drops the capture without consuming", () => {
    requestFreeLabel("telegram:1");
    clearFreeLabel("telegram:1");
    expect(isAwaitingFreeLabel("telegram:1")).toBe(false);
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    requestFreeLabel("telegram:1");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(isAwaitingFreeLabel("telegram:1")).toBe(false);
    expect(consumeFreeLabel("telegram:1")).toBe(false);
  });
});
