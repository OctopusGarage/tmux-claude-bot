import { describe, expect, it } from "vitest";
import { autopilotActionList } from "../../src/tui/autopilot-panel.js";

describe("autopilot-panel helpers", () => {
  it("always exposes only supervisor delegation", () => {
    const a = autopilotActionList();
    expect(a).toEqual([{ key: "delegate", label: "Continue via supervisor", verb: "delegate" }]);
  });
});
