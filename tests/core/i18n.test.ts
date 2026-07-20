import { afterEach, describe, expect, it, vi } from "vitest";

// setUiLang persists to .env — stub the writer so tests don't touch the real file.
vi.mock("../../src/core/infra/env-store.js", () => ({ persistEnvVar: vi.fn() }));

import { messages, resolveUiLang, setUiLang, UI_LANGS } from "../../src/core/i18n/index.js";
import { parseSetupLang, setupMessages } from "../../src/core/i18n/setup.js";

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

  it("keeps Telegram handler errors free of Lark-only group recovery copy", () => {
    snap("TELEGRAM_UI_LANG", "LARK_UI_LANG");
    process.env.TELEGRAM_UI_LANG = "zh";
    process.env.LARK_UI_LANG = "zh";
    expect(messages("telegram").handlerErrorTelegram).not.toContain("群");
    expect(messages("telegram").handlerErrorTelegram).not.toContain("/restore");
    expect(messages("lark").handlerError).toContain("群组");
    expect(messages("lark").handlerError).toContain("/restore");
  });

  // Passing a string array as every positional arg renders all entries (works for
  // both `${n}` interpolation and the lone `dirs.join(...)` call) so each catalog's
  // function bodies are exercised, not just its static strings.
  const renderAll = (catalog: Record<string, unknown>): string[] =>
    Object.values(catalog).map((v) =>
      typeof v === "function" ? String(v(["a", "b"], ["a", "b"])) : String(v),
    );

  it("every UI language is complete and renders non-empty copy", () => {
    snap("TELEGRAM_UI_LANG");
    process.env.TELEGRAM_UI_LANG = "zh";
    const referenceKeys = Object.keys(messages("telegram")).sort();
    for (const { code } of UI_LANGS) {
      process.env.TELEGRAM_UI_LANG = code;
      const catalog = messages("telegram") as unknown as Record<string, unknown>;
      expect(Object.keys(catalog).sort(), `${code} key set`).toEqual(referenceKeys);
      for (const rendered of renderAll(catalog)) {
        expect(rendered.length, `${code} non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every UI language has a complete setup-wizard catalog", () => {
    const referenceKeys = Object.keys(setupMessages("en")).sort();
    for (const { code } of UI_LANGS) {
      const catalog = setupMessages(code) as unknown as Record<string, unknown>;
      expect(Object.keys(catalog).sort(), `${code} setup key set`).toEqual(referenceKeys);
      for (const rendered of renderAll(catalog)) {
        expect(rendered.length, `${code} setup non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it("parseSetupLang recognizes every UI language by number, code, and native label", () => {
    expect(parseSetupLang("3")).toBe("zh-TW");
    expect(parseSetupLang("zh-TW")).toBe("zh-TW");
    expect(parseSetupLang("繁體中文")).toBe("zh-TW");
    expect(parseSetupLang("5")).toBe("ja");
    expect(parseSetupLang("日本語")).toBe("ja");
    expect(parseSetupLang("6")).toBe("es");
    expect(parseSetupLang("Español")).toBe("es");
    expect(parseSetupLang("nope")).toBeNull();
  });
});
