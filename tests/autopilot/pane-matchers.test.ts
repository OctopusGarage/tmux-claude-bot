import { describe, expect, it } from "vitest";
import { paneSemantics } from "../../src/core/autopilot/pane-matchers.js";

describe("paneSemantics", () => {
  it("flags API errors", () => {
    expect(paneSemantics("⏺ API Error: Connection error.").apiError).toBe(true);
    expect(paneSemantics("Error: overloaded_error").apiError).toBe(true);
    expect(paneSemantics("all good").apiError).toBe(false);
  });

  it("flags hard stops separately from transient errors", () => {
    expect(paneSemantics("You are out of credits").hardStop).toBe(true);
    expect(paneSemantics("usage limit reached").hardStop).toBe(true);
    expect(paneSemantics("context low — run /compact").hardStop).toBe(true);
    expect(paneSemantics("API Error: terminated").hardStop).toBe(false);
  });

  it("detects a waiting input prompt", () => {
    expect(paneSemantics("Do you want to proceed? (y/n)").inputPromptWaiting).toBe(true);
    expect(paneSemantics("│ > ").inputPromptWaiting).toBe(true);
    expect(paneSemantics("✻ Thinking… (esc to interrupt)").inputPromptWaiting).toBe(false);
  });
});
