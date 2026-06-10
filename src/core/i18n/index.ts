import { persistEnvVar } from "../env-store.js";
import type { Channel } from "../project-manager.js";
import { en } from "./catalog/en.js";
import { yue } from "./catalog/yue.js";
import { type Messages, zh } from "./catalog/zh.js";

export type { Messages };

/** Supported UI languages (display order: English, 中文, 粤语). `zh` stays the
 * canonical catalog shape + default. */
export type Lang = "en" | "zh" | "yue";

const CATALOGS: Record<Lang, Messages> = { en, zh, yue };

/** UI languages offered in the /lang picker (code + native label). */
export const UI_LANGS: ReadonlyArray<{ code: Lang; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "yue", label: "粵語" },
];

export const DEFAULT_UI_LANG: Lang = "zh";

function uiLangEnvKey(channel: Channel): string {
  return channel === "telegram" ? "TELEGRAM_UI_LANG" : "LARK_UI_LANG";
}

function asLang(v: string | undefined): Lang | null {
  return v === "en" || v === "zh" || v === "yue" ? v : null;
}

export function isUiLang(v: string): v is Lang {
  return asLang(v) !== null;
}

/** Resolve a channel's UI language: per-channel override → shared UI_LANG → zh. */
export function resolveUiLang(channel: Channel): Lang {
  return (
    asLang(process.env[uiLangEnvKey(channel)]) ?? asLang(process.env.UI_LANG) ?? DEFAULT_UI_LANG
  );
}

/** The message catalog for a channel's current UI language. */
export function messages(channel: Channel): Messages {
  return CATALOGS[resolveUiLang(channel)];
}

/** Set + persist a channel's UI language (live + survives restart). */
export function setUiLang(channel: Channel, lang: Lang): void {
  const key = uiLangEnvKey(channel);
  process.env[key] = lang;
  persistEnvVar(key, lang);
}
