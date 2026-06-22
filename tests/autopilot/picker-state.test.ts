import { describe, expect, it } from "vitest";
import {
  adjustRounds,
  clearPicker,
  getPicker,
  toggleGoal,
} from "../../src/core/autopilot/picker-state.js";

describe("picker-state", () => {
  it("defaults to empty selection, 1 round", () => {
    clearPicker("s1");
    expect(getPicker("s1")).toEqual({ selected: [], rounds: 1 });
  });
  it("toggles goals preserving order, and off again", () => {
    clearPicker("s1");
    toggleGoal("s1", "fix-tests");
    toggleGoal("s1", "code-review");
    expect(getPicker("s1").selected).toEqual(["fix-tests", "code-review"]);
    toggleGoal("s1", "fix-tests");
    expect(getPicker("s1").selected).toEqual(["code-review"]);
  });
  it("clamps rounds to [1, max]", () => {
    clearPicker("s1");
    adjustRounds("s1", -5, 10);
    expect(getPicker("s1").rounds).toBe(1);
    adjustRounds("s1", 999, 10);
    expect(getPicker("s1").rounds).toBe(10);
  });
});
