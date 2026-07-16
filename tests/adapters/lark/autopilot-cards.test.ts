import { describe, expect, it } from "vitest";
import {
  autopilotGateCard,
  autopilotGoalPickerCard,
  autopilotPanelCard,
} from "../../../src/adapters/lark/cards.js";
import type { AutopilotView } from "../../../src/core/autopilot/autopilot-view.js";

const base: AutopilotView = {
  enabled: false,
  mode: "off",
  statusLine: "status",
  gatePending: false,
  globalOn: false,
  goals: [
    { id: "fix-tests", title: "Fix tests", selected: false, skills: [] },
    { id: "code-review", title: "Code review", selected: true, skills: ["code-review"] },
  ],
  rounds: 2,
  maxRounds: 10,
};

describe("lark autopilot cards", () => {
  it("off panel → only an enable affordance (no pick/stop)", () => {
    const card = autopilotPanelCard(base, "s1");
    const texts = JSON.stringify(card);
    expect(texts).toContain("ap_toggle");
    expect(texts).not.toContain("ap_pick");
    expect(texts).not.toContain("ap_stop");
  });
  it("cycle panel → disable + pick + global + stop", () => {
    const card = autopilotPanelCard(
      {
        ...base,
        enabled: true,
        mode: "cycle",
        cycle: { goalId: "fix-tests", pos: 1, total: 2, round: 1, rounds: 2 },
      },
      "s1",
    );
    const j = JSON.stringify(card);
    expect(j).toContain("ap_pick");
    expect(j).toContain("ap_stop");
    expect(j).toContain("ap_toggle");
  });
  it("gate pending → confirm/continue present", () => {
    const j = JSON.stringify(
      autopilotPanelCard({ ...base, enabled: true, mode: "keepalive", gatePending: true }, "s1"),
    );
    expect(j).toContain("ap_confirm");
    expect(j).toContain("ap_reject");
  });
  it("gate pending while disabled → confirm/continue still surface above enable", () => {
    // a gate can fire as autopilot is being turned off; the gate row renders
    // before the enable/disable branch, so confirm/continue must still appear.
    const j = JSON.stringify(
      autopilotPanelCard({ ...base, enabled: false, mode: "off", gatePending: true }, "s1"),
    );
    expect(j).toContain("ap_confirm");
    expect(j).toContain("ap_reject");
    expect(j).toContain("ap_toggle"); // the enable button is still there below the gate row
  });
  it("picker → selected goal marked, rounds shown, start summarises", () => {
    const j = JSON.stringify(autopilotGoalPickerCard({ ...base, enabled: false }, "s1"));
    expect(j).toContain("✓"); // code-review is selected
    expect(j).toContain("skill: code-review");
    expect(j).toContain("ap_goal_toggle");
    expect(j).toContain("ap_rounds");
    expect(j).toContain("ap_start");
  });
  it("gate card → two buttons carrying the session", () => {
    const j = JSON.stringify(autopilotGateCard("s1"));
    expect(j).toContain("ap_confirm");
    expect(j).toContain("ap_reject");
    expect(j).toContain("s1");
  });

  // group param: the global toggle is host-wide and must be omitted in bound groups
  it("panel group=false → global toggle present", () => {
    const j = JSON.stringify(
      autopilotPanelCard({ ...base, enabled: true, mode: "keepalive" }, "s1", false),
    );
    expect(j).toContain("ap_global");
  });
  it("panel group=true → global toggle omitted", () => {
    const j = JSON.stringify(
      autopilotPanelCard({ ...base, enabled: true, mode: "keepalive" }, "s1", true),
    );
    expect(j).not.toContain("ap_global");
  });
  it("panel group=true cycle → stop button still present (per-session op), global absent", () => {
    const j = JSON.stringify(
      autopilotPanelCard(
        {
          ...base,
          enabled: true,
          mode: "cycle",
          cycle: { goalId: "fix-tests", pos: 1, total: 2, round: 1, rounds: 2 },
        },
        "s1",
        true,
      ),
    );
    expect(j).toContain("ap_stop");
    expect(j).not.toContain("ap_global");
  });
});
