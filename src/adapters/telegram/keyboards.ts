import { InlineKeyboard } from "grammy";
import {
  ACTION_META,
  TELEGRAM_COLLAPSED_ROW,
  TELEGRAM_EXPANDED_ROWS,
  TELEGRAM_PRIMARY_ROWS,
} from "../../core/action-registry.js";
import { isMessageAction, type MessageAction } from "../../core/dispatch.js";
import { isUiLang, type Lang, messages, UI_LANGS } from "../../core/i18n/index.js";
import type { ProjectButton, RecentButton } from "../../core/project-ops.js";
import { VOICE_LANGS } from "../../core/voice-support.js";

export type { ProjectButton, RecentButton } from "../../core/project-ops.js";

/**
 * Parsed inline-button callback. Telegram limits callback_data to 64 bytes, so
 * we use a compact scheme keyed on the project's 6-char short id:
 *   a:<action>:<sid>  control action (esc/interrupt/enter/restart/…)
 *   s:<sid>           switch to project
 *   r:<sid>           remove project
 */
export type CallbackAction =
  | { kind: "act"; action: string; sid: string }
  | { kind: "switch"; sid: string }
  | { kind: "remove"; sid: string }
  | { kind: "more"; sid: string }
  | { kind: "less"; sid: string }
  | { kind: "add"; sid: string }
  | { kind: "peek"; sid: string }
  | { kind: "history"; sid: string }
  | { kind: "delmode" }
  | { kind: "dellist" }
  | { kind: "listalive" }
  | { kind: "queuestatus" }
  | { kind: "voicelang"; lang: string }
  | { kind: "uilang"; lang: Lang };

export function encodeControlAction(action: string, sid: string): string {
  return `a:${action}:${sid}`;
}

type SidKind = "switch" | "remove" | "more" | "less" | "add" | "peek" | "history";
const SID_TAGS: Record<string, SidKind> = {
  s: "switch",
  r: "remove",
  m: "more",
  l: "less",
  g: "add",
  pk: "peek",
  hi: "history",
};

export function parseCallbackData(data: string): CallbackAction | null {
  // Argument-less toggles / views.
  if (data === "dm") return { kind: "delmode" };
  if (data === "dl") return { kind: "dellist" };
  if (data === "la") return { kind: "listalive" };
  if (data === "qs") return { kind: "queuestatus" };
  const parts = data.split(":");
  const [tag] = parts;
  if (tag === "a") {
    const action = parts[1];
    const sid = parts[2];
    if (parts.length !== 3 || !action || !sid) return null;
    // Only accept verbs that map to a real, safe MessageAction — never trust
    // arbitrary callback_data as a command.
    if (!isMessageAction(action)) return null;
    return { kind: "act", action, sid };
  }
  if (tag === "vl") {
    const lang = parts[1];
    if (parts.length !== 2 || !lang || !isVoiceLang(lang)) return null;
    return { kind: "voicelang", lang };
  }
  if (tag === "ul") {
    const lang = parts[1];
    if (parts.length !== 2 || !lang || !isUiLang(lang)) return null;
    return { kind: "uilang", lang };
  }
  if (tag !== undefined && tag in SID_TAGS) {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: SID_TAGS[tag] as SidKind, sid };
  }
  return null;
}

function isVoiceLang(code: string): boolean {
  return VOICE_LANGS.some((l) => l.code === code);
}

/**
 * Voice-language picker: one button per language, the active one marked and
 * inert. Tapping sends `vl:<code>`, handled in handleCallbackQuery.
 */
export function buildVoiceLangKeyboard(current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  VOICE_LANGS.forEach((l, i) => {
    if (l.code === current) kb.text(`✅ ${l.label}`, "noop");
    else kb.text(l.label, `vl:${l.code}`);
    if (i < VOICE_LANGS.length - 1) kb.row();
  });
  return kb;
}

/** UI-language picker: one button per language, the active one marked. Tapping
 * sends `ul:<code>`, handled in handleCallbackQuery. */
export function buildLangKeyboard(current: Lang): InlineKeyboard {
  const kb = new InlineKeyboard();
  UI_LANGS.forEach((l, i) => {
    if (l.code === current) kb.text(`✅ ${l.label}`, "noop");
    else kb.text(l.label, `ul:${l.code}`);
    if (i < UI_LANGS.length - 1) kb.row();
  });
  return kb;
}

function addActionRows(kb: InlineKeyboard, rows: MessageAction[][], sid: string): InlineKeyboard {
  const m = messages("telegram");
  for (const row of rows) {
    for (const action of row) {
      const meta = ACTION_META[action];
      if (meta) kb.text(m[meta.btnKey] as string, encodeControlAction(action, sid));
    }
    kb.row();
  }
  return kb;
}

// The primary control rows, shared by the collapsed and expanded keyboards.
function primaryRows(kb: InlineKeyboard, sid: string): InlineKeyboard {
  return addActionRows(kb, TELEGRAM_PRIMARY_ROWS, sid);
}

/** Collapsed control panel: the most-used controls + views, then a "more" toggle. */
export function buildControlKeyboard(sid: string): InlineKeyboard {
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  for (const action of TELEGRAM_COLLAPSED_ROW) {
    const meta = ACTION_META[action];
    if (meta) kb.text(m[meta.btnKey] as string, encodeControlAction(action, sid));
  }
  return kb
    .row()
    .text(m.btnPeek, `pk:${sid}`)
    .text(m.btnHistory, `hi:${sid}`)
    .row()
    .text(m.btnProjects, "la")
    .text(m.btnQueue, "qs")
    .row()
    .text(m.btnMore, `m:${sid}`);
}

/** Expanded control panel: primary + secondary controls + a "collapse" toggle. */
export function buildExpandedControlKeyboard(sid: string): InlineKeyboard {
  const m = messages("telegram");
  const kb = primaryRows(new InlineKeyboard(), sid);
  addActionRows(kb, TELEGRAM_EXPANDED_ROWS, sid);
  return kb
    .text(m.btnPeek, `pk:${sid}`)
    .text(m.btnHistory, `hi:${sid}`)
    .row()
    .text(m.btnProjects, "la")
    .text(m.btnQueue, "qs")
    .row()
    .text(m.btnCollapse, `l:${sid}`);
}

/**
 * Project list: one full-width row per project (tap to switch; the active one
 * is marked and inert), plus a delete-mode toggle. Telegram splits a row's
 * width evenly and centers labels, so a per-row delete button would always be
 * half-width — instead delete lives behind its own mode (buildProjectDeleteKeyboard).
 */
export function buildProjectKeyboard(projects: ProjectButton[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of projects) {
    if (p.active) {
      kb.text(`✅ ${p.label}`, "noop").row();
    } else {
      kb.text(`🔀 ${p.label}`, `s:${p.sid}`).row();
    }
  }
  return kb.text(messages("telegram").btnDeleteMode, "dm");
}

/** Delete mode: one full-width "delete <project>" row each, plus a cancel toggle. */
export function buildProjectDeleteKeyboard(projects: ProjectButton[]): InlineKeyboard {
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(`${m.btnRemove} ${p.label}`, `r:${p.sid}`).row();
  }
  return kb.text(m.btnCancel, "dl");
}

/**
 * Recent-projects list: one full-width row per project — tap an alive project
 * to switch, tap a stopped one to (re)create it. The active one is inert.
 */
export function buildRecentKeyboard(projects: RecentButton[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  projects.forEach((p, i) => {
    if (p.active) kb.text(`✅ ${p.label}`, "noop");
    else if (p.alive) kb.text(`🔀 ${p.label}`, `s:${p.sid}`);
    else kb.text(`➕ ${p.label}`, `g:${p.sid}`);
    if (i < projects.length - 1) kb.row();
  });
  return kb;
}
