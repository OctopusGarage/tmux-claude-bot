import { beforeAll, describe, expect, it } from "vitest";
import {
  buildAutopilotPanelKeyboard,
  buildOpportunityNotificationKeyboard,
  parseCallbackData,
} from "../../../src/adapters/telegram/keyboards.js";
import { setUiLang } from "../../../src/core/i18n/index.js";

beforeAll(() => {
  setUiLang("telegram", "en");
});

describe("autopilot telegram callbacks", () => {
  it("parses the panel prefixes", () => {
    expect(parseCallbackData("apd:abc123")).toEqual({ kind: "apDelegate", sid: "abc123" });
    expect(parseCallbackData("app:abc123")).toEqual({ kind: "apPlan", sid: "abc123" });
    expect(parseCallbackData("apc:abc123")).toEqual({ kind: "apConfirmDelegate", sid: "abc123" });
    expect(parseCallbackData("apz:abc123")).toEqual({
      kind: "apCancelDelegate",
      sid: "abc123",
    });
    expect(parseCallbackData("ap:abc123")).toBeNull();
    expect(parseCallbackData("apt:abc123")).toBeNull();
    expect(parseCallbackData("apg:abc123")).toBeNull();
    expect(parseCallbackData("apgo:abc123")).toBeNull();
    expect(parseCallbackData("apgt:2:abc123")).toBeNull();
    expect(parseCallbackData("apr:-1:abc123")).toBeNull();
    expect(parseCallbackData("apglobal:1:abc123")).toBeNull();
    expect(parseCallbackData("apstop:abc123")).toBeNull();
  });

  it("panel view exposes direct delegation and plan preview", () => {
    const kb = buildAutopilotPanelKeyboard("abc123");
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    const data = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(labels).toContain("🚀 Delegate now");
    expect(labels).toContain("📋 Review plan first");
    expect(data).toContain("apd:abc123");
    expect(data).toContain("app:abc123");
    expect(labels).not.toContain("🎯 Pick goals");
    expect(labels).not.toContain("Enable keep-alive/goals");
  });

  it("active delegated task shows cancel instead of delegate", () => {
    const kb = buildAutopilotPanelKeyboard("abc123", true);
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    const data = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(labels).toContain("⛔ Cancel delegate");
    expect(labels).not.toContain("🚀 Delegate now");
    expect(labels).not.toContain("📋 Review plan first");
    expect(data).toContain("apz:abc123");
  });

  it("gate pending no longer surfaces old keep-alive controls", () => {
    const kb = buildAutopilotPanelKeyboard("abc123");
    const data = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(data).not.toContain("apx:abc123");
    expect(data).toContain("apd:abc123");
  });

  it("parses plan-confirmation callback and rejects old reject prefix", () => {
    expect(parseCallbackData("apc:abc123")).toEqual({ kind: "apConfirmDelegate", sid: "abc123" });
    expect(parseCallbackData("apx:abc123")).toBeNull();
  });

  it("parses opportunity notification callbacks", () => {
    expect(parseCallbackData("od:abc12345,def67890")).toEqual({
      kind: "opportunityDiscussAll",
      tokens: ["abc12345", "def67890"],
    });
    expect(parseCallbackData("ox:abc12345")).toEqual({
      kind: "opportunityDismissAll",
      tokens: ["abc12345"],
    });
    expect(parseCallbackData("od:bad/token")).toBeNull();
  });

  it("builds opportunity notification buttons from compact id tokens", () => {
    const kb = buildOpportunityNotificationKeyboard([
      {
        id: "alcove-20260729-ad409ff3",
        title: "Add explain command",
        projectName: "alcove",
        category: "developer-experience",
        confidence: "high",
        estimatedComplexity: "small",
        status: "proposed",
        value: "Faster support.",
      },
    ]);
    const data = kb?.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);

    expect(data).toEqual(["od:ad409ff3", "ox:ad409ff3"]);
  });
});
