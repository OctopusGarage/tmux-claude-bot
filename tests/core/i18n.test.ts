import { afterEach, describe, expect, it, vi } from "vitest";

// setUiLang persists to .env — stub the writer so tests don't touch the real file.
vi.mock("../../src/core/env-store.js", () => ({ persistEnvVar: vi.fn() }));

import { messages, resolveUiLang, setUiLang } from "../../src/core/i18n/index.js";

const saved: Record<string, string | undefined> = {};
function snap(...keys: string[]): void {
  for (const k of keys) saved[k] = process.env[k];
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("i18n", () => {
  it("defaults to zh per channel", () => {
    snap("TELEGRAM_UI_LANG", "LARK_UI_LANG", "UI_LANG");
    delete process.env.TELEGRAM_UI_LANG;
    delete process.env.LARK_UI_LANG;
    delete process.env.UI_LANG;
    expect(resolveUiLang("telegram")).toBe("zh");
    expect(messages("telegram").switched).toBe("已切换");
  });

  it("resolves a per-channel override, isolated across channels", () => {
    snap("TELEGRAM_UI_LANG", "LARK_UI_LANG");
    process.env.TELEGRAM_UI_LANG = "en";
    process.env.LARK_UI_LANG = "zh";
    expect(resolveUiLang("telegram")).toBe("en");
    expect(resolveUiLang("lark")).toBe("zh");
    expect(messages("telegram").switched).toBe("Switched");
    expect(messages("lark").switched).toBe("已切换");
  });

  it("supports Cantonese (yue)", () => {
    snap("LARK_UI_LANG");
    process.env.LARK_UI_LANG = "yue";
    expect(resolveUiLang("lark")).toBe("yue");
    expect(messages("lark").switched).toBe("已切換");
    expect(messages("lark").doneShort).toBe("完成");
  });

  it("falls back to the shared UI_LANG default", () => {
    snap("TELEGRAM_UI_LANG", "UI_LANG");
    delete process.env.TELEGRAM_UI_LANG;
    process.env.UI_LANG = "en";
    expect(resolveUiLang("telegram")).toBe("en");
  });

  it("setUiLang updates the channel's language live", () => {
    snap("LARK_UI_LANG");
    setUiLang("lark", "en");
    expect(resolveUiLang("lark")).toBe("en");
    expect(messages("lark").queuedAt(3)).toBe("Queued · #3");
  });

  it("interpolates parameters", () => {
    snap("TELEGRAM_UI_LANG");
    process.env.TELEGRAM_UI_LANG = "zh";
    expect(messages("telegram").queuedAt(3)).toBe("已排队 · 第 3 位");
    expect(messages("telegram").queueFull(30)).toContain("30");
  });
});
