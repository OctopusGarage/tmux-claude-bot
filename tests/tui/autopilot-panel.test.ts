import { describe, expect, it } from "vitest";
import type { AutopilotView } from "../../src/core/autopilot/autopilot-view.js";
import { autopilotActionList, goalsVerb } from "../../src/tui/autopilot-panel.js";

const v = (over: Partial<AutopilotView>): AutopilotView => ({
  enabled: false,
  mode: "off",
  statusLine: "s",
  gatePending: false,
  globalOn: false,
  goals: [],
  rounds: 1,
  maxRounds: 10,
  ...over,
});

describe("autopilot-panel helpers", () => {
  it("off → only toggle (enable)", () => {
    const a = autopilotActionList(v({}));
    expect(a.map((x) => x.key)).toEqual(["toggle"]);
    expect(a[0]).toMatchObject({ verb: "on" });
  });
  it("cycle → toggle(off)/pick/global/stop", () => {
    const a = autopilotActionList(v({ enabled: true, mode: "cycle" }));
    expect(a.map((x) => x.key)).toEqual(["toggle", "pick", "global", "stop"]);
    expect(a.find((x) => x.key === "toggle")).toMatchObject({ verb: "off" });
  });
  it("keepalive (no cycle) → no stop", () => {
    const a = autopilotActionList(v({ enabled: true, mode: "keepalive" }));
    expect(a.map((x) => x.key)).toEqual(["toggle", "pick", "global"]);
  });
  it("gate pending → confirm + continue lead", () => {
    const a = autopilotActionList(v({ enabled: true, mode: "keepalive", gatePending: true }));
    expect(a[0]?.key).toBe("confirm");
    expect(a[1]?.key).toBe("continue");
  });
  it("global label/verb reflects current state", () => {
    expect(
      autopilotActionList(v({ enabled: true, globalOn: false })).find((x) => x.key === "global"),
    ).toMatchObject({ verb: "global on" });
    expect(
      autopilotActionList(v({ enabled: true, globalOn: true })).find((x) => x.key === "global"),
    ).toMatchObject({ verb: "global off" });
  });
  it("goalsVerb joins ids + rounds", () => {
    expect(goalsVerb(["fix-tests", "code-review"], 3)).toBe("goals fix-tests,code-review rounds 3");
  });
});
