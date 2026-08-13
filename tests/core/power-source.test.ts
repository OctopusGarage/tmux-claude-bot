import { describe, expect, it } from "vitest";
import { parseMacPowerSource } from "../../src/core/platform/power-source.js";

describe("macOS power source", () => {
  it.each([
    ["Now drawing from 'AC Power'\n", "ac"],
    ["Now drawing from 'Battery Power'\n", "battery"],
    ["unexpected output", "unknown"],
  ] as const)("maps %j to %s", (output, expected) => {
    expect(parseMacPowerSource(output)).toBe(expected);
  });
});
