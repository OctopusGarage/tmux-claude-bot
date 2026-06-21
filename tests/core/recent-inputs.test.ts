import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUTS,
  inputButtonLabel,
  lookupInput,
  MAX_INPUTS,
  parseInputsLimit,
  sanitizeRecentInput,
  storeInputList,
  stripInterruptMarker,
} from "../../src/core/read/recent-inputs.js";

describe("recent-inputs", () => {
  it("parseInputsLimit clamps to [1, max] and defaults for no/bad arg", () => {
    expect(parseInputsLimit(undefined)).toBe(DEFAULT_INPUTS);
    expect(parseInputsLimit("0")).toBe(DEFAULT_INPUTS);
    expect(parseInputsLimit("abc")).toBe(DEFAULT_INPUTS);
    expect(parseInputsLimit("3")).toBe(3);
    expect(parseInputsLimit("999")).toBe(MAX_INPUTS);
  });

  it("inputButtonLabel one-lines, numbers, and length-caps", () => {
    expect(inputButtonLabel("hello", 0)).toBe("1. hello");
    expect(inputButtonLabel("a\nb\n  c", 1)).toBe("2. a b c");
    const label = inputButtonLabel("x".repeat(100), 2);
    expect(label.startsWith("3. ")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual("3. ".length + 48);
  });

  it("stripInterruptMarker drops interrupt markers, keeps real prompts", () => {
    expect(stripInterruptMarker("[Request interrupted by user]")).toBe("");
    expect(stripInterruptMarker("[Request interrupted by user for tool use]")).toBe("");
    expect(stripInterruptMarker("[Request interrupted by user] fix the bug")).toBe("fix the bug");
    expect(stripInterruptMarker("deploy the service")).toBe("deploy the service");
    // a bracketed token that isn't the interrupt marker is left alone
    expect(stripInterruptMarker("[note] do the thing")).toBe("[note] do the thing");
  });

  it("sanitizeRecentInput strips injected blocks and keeps the real prompt", () => {
    // pure injected turns → empty (filtered out of /inputs)
    expect(sanitizeRecentInput("<task notification>bg job done</task notification>")).toBe("");
    expect(sanitizeRecentInput("<task-notification>x</task-notification>")).toBe("");
    expect(sanitizeRecentInput("<system-reminder>As you answer…</system-reminder>")).toBe("");
    // real input with a trailing injected reminder → keep only the input
    expect(
      sanitizeRecentInput("fix the failing test\n<system-reminder>note</system-reminder>"),
    ).toBe("fix the failing test");
    // interrupt marker still handled
    expect(sanitizeRecentInput("[Request interrupted by user] retry")).toBe("retry");
    // pure system turns → empty
    expect(sanitizeRecentInput("Summary: the conversation so far…")).toBe("");
    expect(
      sanitizeRecentInput("This session is being continued from a previous conversation…"),
    ).toBe("");
    // slash command rendered readably
    expect(sanitizeRecentInput("<command-name>/clear</command-name>")).toBe("/clear");
    expect(sanitizeRecentInput("<command-message>/simplify the code</command-message>")).toBe(
      "/simplify the code",
    );
    // a plain prompt is untouched
    expect(sanitizeRecentInput("deploy the service")).toBe("deploy the service");
  });

  it("store + lookup returns the EXACT prompt; bad token/idx → null", () => {
    const token = storeInputList("sess-1", ["fix the bug", "run the tests"]);
    expect(lookupInput(token, 0)).toEqual({ session: "sess-1", prompt: "fix the bug" });
    expect(lookupInput(token, 1)).toEqual({ session: "sess-1", prompt: "run the tests" });
    expect(lookupInput(token, 9)).toBeNull();
    expect(lookupInput("no-such-token", 0)).toBeNull();
  });
});
