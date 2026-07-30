import { describe, expect, it } from "vitest";
import {
  autopilotGateCard,
  autopilotPanelCard,
  opportunityDigestCard,
} from "../../../src/adapters/lark/cards.js";

describe("lark autopilot cards", () => {
  it("panel only exposes supervisor delegation", () => {
    const card = autopilotPanelCard("s1");
    const texts = JSON.stringify(card);
    expect(texts).toContain("ap_delegate");
    expect(texts).not.toContain("ap_toggle");
    expect(texts).not.toContain("ap_pick");
    expect(texts).not.toContain("ap_stop");
  });
  it("active delegated task → cancel delegate affordance", () => {
    const card = autopilotPanelCard("s1", false, true);
    const texts = JSON.stringify(card);
    expect(texts).toContain("ap_cancel_delegate");
    expect(texts).not.toContain("ap_delegate");
  });
  it("cycle state still renders only delegation", () => {
    const card = autopilotPanelCard("s1");
    const j = JSON.stringify(card);
    expect(j).toContain("ap_delegate");
    expect(j).not.toContain("ap_pick");
    expect(j).not.toContain("ap_stop");
    expect(j).not.toContain("ap_toggle");
  });
  it("gate pending does not render old confirm/continue controls", () => {
    const j = JSON.stringify(autopilotPanelCard("s1"));
    expect(j).not.toContain("ap_confirm");
    expect(j).not.toContain("ap_reject");
    expect(j).toContain("ap_delegate");
  });
  it("gate pending while disabled still renders only delegation", () => {
    const j = JSON.stringify(autopilotPanelCard("s1"));
    expect(j).not.toContain("ap_confirm");
    expect(j).not.toContain("ap_reject");
    expect(j).not.toContain("ap_toggle");
    expect(j).toContain("ap_delegate");
  });
  it("gate card → two buttons carrying the session", () => {
    const j = JSON.stringify(autopilotGateCard("s1"));
    expect(j).toContain("ap_confirm");
    expect(j).toContain("ap_reject");
    expect(j).toContain("s1");
  });

  it("panel group=false → global toggle omitted", () => {
    const j = JSON.stringify(autopilotPanelCard("s1", false));
    expect(j).not.toContain("ap_global");
  });
  it("panel group=true → global toggle omitted", () => {
    const j = JSON.stringify(autopilotPanelCard("s1", true));
    expect(j).not.toContain("ap_global");
  });
  it("panel group=true cycle → stop/global buttons omitted", () => {
    const j = JSON.stringify(autopilotPanelCard("s1", true));
    expect(j).not.toContain("ap_stop");
    expect(j).not.toContain("ap_global");
  });
});

describe("lark opportunity cards", () => {
  it("digest card keeps discussion and delegation decoupled", () => {
    const j = JSON.stringify(
      opportunityDigestCard({
        title: "Opportunity suggestions: api",
        body: "Project: api\nSuggestions: 1",
        opportunities: [
          {
            id: "api-20260729-abc123",
            title: "Add explain command",
            projectName: "api",
            category: "developer-experience",
            confidence: "high",
            estimatedComplexity: "small",
            status: "proposed",
            value: "Faster support.",
          },
        ],
      }),
    );

    expect(j).toContain("oppdiscussall");
    expect(j).toContain("oppdismissall");
    expect(j).toContain("api · 1 个建议");
    expect(j).toContain("Add explain command");
    expect(j).toContain("Faster support.");
    expect(j.indexOf("oppdiscussall")).toBeGreaterThan(j.indexOf("Faster support."));
    expect(j).toContain("暂不处理");
    expect(j).not.toContain("oppshow");
    expect(j).not.toContain("oppdelegate");
    expect(j).not.toContain("Project:");
    expect(j).not.toContain("ID:");
    expect(j).not.toContain("Category:");
    expect(j).not.toContain("Commands:");
  });
});
