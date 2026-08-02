import { describe, expect, it } from "vitest";
import { autopilotPanelCard, opportunityDigestCard } from "../../../src/adapters/lark/cards.js";

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
  const richOpportunity = {
    id: "api-20260729-abc123",
    title: "Add explain command",
    projectName: "api",
    category: "developer-experience",
    confidence: "high" as const,
    estimatedComplexity: "small" as const,
    status: "proposed" as const,
    value:
      "Faster support triage by letting maintainers ask the bot why a command failed, which files were checked, and what evidence was collected before proposing a fix.",
    problem:
      "Maintainers currently need to read raw logs and transcripts to understand a failed command before deciding whether the suggestion is worth discussing.",
    recommendedApproach:
      "Add a read-only explain flow that summarizes command evidence and links back to the stored report.",
  };

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
    expect(j).toContain("oppshow");
    expect(j).not.toContain("oppdelegate");
    expect(j).not.toContain("Project:");
    expect(j).not.toContain("ID:");
    expect(j).not.toContain("Category:");
    expect(j).not.toContain("Commands:");
  });

  it("digest card shows readable per-suggestion detail and item actions", () => {
    const card = opportunityDigestCard({
      title: "Opportunity suggestions: api",
      body: "Project: api\nSuggestions: 1",
      opportunities: [richOpportunity],
    });
    const j = JSON.stringify(card);

    expect(j).toContain("Problem:");
    expect(j).toContain(richOpportunity.problem);
    expect(j).toContain("Value:");
    expect(j).toContain(richOpportunity.value);
    expect(j).toContain("Approach:");
    expect(j).toContain(richOpportunity.recommendedApproach);
    expect(j).not.toContain("...");
    expect(j).toContain('"cmd":"oppshow"');
    expect(j).toContain('"cmd":"oppdiscuss"');
    expect(j).toContain('"cmd":"oppdismiss"');
    expect(j).toContain('"id":"api-20260729-abc123"');
  });
});
