import { InlineKeyboard } from "grammy";
import { isMessageAction } from "./executor.js";

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
  | { kind: "queuestatus" };

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
  if (tag !== undefined && tag in SID_TAGS) {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: SID_TAGS[tag] as SidKind, sid };
  }
  return null;
}

// The primary control rows, shared by the collapsed and expanded keyboards.
function primaryRows(kb: InlineKeyboard, sid: string): InlineKeyboard {
  return kb
    .text("⏎ Enter", encodeControlAction("enter", sid))
    .text("✋ 中断", encodeControlAction("interrupt", sid))
    .row()
    .text("⎋ Esc", encodeControlAction("esc", sid))
    .text("🔄 重启", encodeControlAction("restart", sid))
    .row();
}

/** Collapsed control panel: the most-used controls + views, then a "more" toggle. */
export function buildControlKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("⎋ Esc", encodeControlAction("esc", sid))
    .text("🧹 clear", encodeControlAction("clear", sid))
    .text("🗜 compact", encodeControlAction("compact", sid))
    .row()
    .text("👁 peek", `pk:${sid}`)
    .text("📜 历史", `hi:${sid}`)
    .row()
    .text("📁 项目", "la")
    .text("📋 队列", "qs")
    .row()
    .text("⌨️ 更多控制 ▾", `m:${sid}`);
}

/** Expanded control panel: primary + secondary controls + a "collapse" toggle. */
export function buildExpandedControlKeyboard(sid: string): InlineKeyboard {
  return primaryRows(new InlineKeyboard(), sid)
    .text("🧹 clear", encodeControlAction("clear", sid))
    .text("🗜 compact", encodeControlAction("compact", sid))
    .row()
    .text("⬆️ up", encodeControlAction("up", sid))
    .text("⬇️ down", encodeControlAction("down", sid))
    .row()
    .text("🚪 exit", encodeControlAction("exit", sid))
    .text("📊 status", encodeControlAction("status", sid))
    .row()
    .text("👁 peek", `pk:${sid}`)
    .text("📜 历史", `hi:${sid}`)
    .row()
    .text("📁 项目", "la")
    .text("📋 队列", "qs")
    .row()
    .text("▴ 收起", `l:${sid}`);
}

export interface ProjectButton {
  sid: string;
  label: string;
  active: boolean;
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
  return kb.text("🗑 删除…", "dm");
}

/** Delete mode: one full-width "delete <project>" row each, plus a cancel toggle. */
export function buildProjectDeleteKeyboard(projects: ProjectButton[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(`🗑 删除 ${p.label}`, `r:${p.sid}`).row();
  }
  return kb.text("✕ 取消", "dl");
}

export interface RecentButton {
  sid: string;
  label: string;
  alive: boolean;
  active: boolean;
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
