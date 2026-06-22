import { beforeAll, describe, expect, it } from "vitest";
import {
  buildAutopilotGateKeyboard,
  buildAutopilotPanelKeyboard,
  parseCallbackData,
} from "../../../src/adapters/telegram/keyboards.js";
import type { AutopilotView } from "../../../src/core/autopilot/autopilot-view.js";
import { setUiLang } from "../../../src/core/i18n/index.js";

beforeAll(() => {
  setUiLang("telegram", "en");
});

const offView: AutopilotView = {
  enabled: false,
  mode: "off",
  statusLine: "",
  gatePending: false,
  globalOn: false,
  goals: [],
  rounds: 1,
  maxRounds: 10,
};

describe("autopilot telegram callbacks", () => {
  it("parses picker prefixes", () => {
    expect(parseCallbackData("apg:abc123")).toEqual({ kind: "apPick", sid: "abc123" });
    expect(parseCallbackData("apgt:2:abc123")).toEqual({
      kind: "apGoalToggle",
      sid: "abc123",
      idx: 2,
    });
    expect(parseCallbackData("apr:-1:abc123")).toEqual({
      kind: "apRounds",
      sid: "abc123",
      delta: -1,
    });
    expect(parseCallbackData("apr:5:abc123")).toBeNull(); // only ±1
    expect(parseCallbackData("apgo:abc123")).toEqual({ kind: "apStart", sid: "abc123" });
  });

  it("parses the panel prefixes", () => {
    expect(parseCallbackData("ap:abc123")).toEqual({ kind: "apPanel", sid: "abc123" });
    expect(parseCallbackData("apt:abc123")).toEqual({ kind: "apToggle", sid: "abc123" });
    expect(parseCallbackData("apglobal:1:abc123")).toEqual({
      kind: "apGlobal",
      sid: "abc123",
      on: true,
    });
    expect(parseCallbackData("apglobal:9:abc123")).toBeNull(); // bad flag rejected
    expect(parseCallbackData("apstop:abc123")).toEqual({ kind: "apStop", sid: "abc123" });
  });

  it("off view shows only enable + back", () => {
    const kb = buildAutopilotPanelKeyboard(offView, "abc123");
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain("🤖 Enable autopilot");
    expect(labels).not.toContain("🎯 Pick goals");
  });

  it("gate pending surfaces confirm/continue", () => {
    const kb = buildAutopilotPanelKeyboard(
      { ...offView, enabled: true, mode: "keepalive", gatePending: true },
      "abc123",
    );
    const data = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(data).toContain("apc:abc123");
    expect(data).toContain("apx:abc123");
  });

  it("parses gate prefixes and builds the gate keyboard", () => {
    expect(parseCallbackData("apc:abc123")).toEqual({ kind: "apConfirm", sid: "abc123" });
    expect(parseCallbackData("apx:abc123")).toEqual({ kind: "apContinue", sid: "abc123" });
    const data = buildAutopilotGateKeyboard("abc123")
      .inline_keyboard.flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(data).toEqual(["apc:abc123", "apx:abc123"]);
  });
});
