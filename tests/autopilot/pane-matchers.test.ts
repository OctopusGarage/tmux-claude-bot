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

  it("auto-recovers the real-world transient API errors (retry, not hard-stop)", () => {
    const transient = [
      "⏺ API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      "⏺ API Error: Connection closed mid-response. The response above may be incomplete.",
      // The rate-limit notice contains "usage limit" — but says "(not your usage limit)";
      // it must classify as a retryable API error, NOT the usage-cap hard stop.
      "⏺ API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
    ];
    for (const t of transient) {
      const s = paneSemantics(t);
      expect(s.apiError).toBe(true);
      expect(s.hardStop).toBe(false);
    }
  });

  it("still treats a genuine usage cap as a hard stop (not a rate limit)", () => {
    const s = paneSemantics("You've reached your usage limit. Resets at 5pm.");
    expect(s.hardStop).toBe(true);
    expect(s.apiError).toBe(false);
  });

  it("detects a waiting input prompt", () => {
    expect(paneSemantics("Do you want to proceed? (y/n)").inputPromptWaiting).toBe(true);
    expect(paneSemantics("│ > ").inputPromptWaiting).toBe(true);
    expect(paneSemantics("✻ Thinking… (esc to interrupt)").inputPromptWaiting).toBe(false);
  });
});
