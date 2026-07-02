import { InlineKeyboard } from "grammy";
import type { AutopilotView } from "../../core/autopilot/autopilot-view.js";
import {
  ACTION_META,
  CONTROL_INTERRUPTS,
  CONTROL_ROWS_FULL,
} from "../../core/command/action-registry.js";
import { isMessageAction, type MessageAction } from "../../core/command/dispatch.js";
import { isUiLang, type Lang, messages, UI_LANGS } from "../../core/i18n/index.js";
import type { BrowseAction, BrowseView } from "../../core/projects/dir-browser.js";
import type { ProjectButton, RecentButton } from "../../core/projects/project-ops.js";
import type { PromptsView } from "../../core/promptlib/view.js";
import { inputButtonLabel } from "../../core/read/recent-inputs.js";
import type { SessionEntry } from "../../core/read/transcript.js";
import { VOICE_LANGS } from "../../core/read/voice-support.js";
import { agentGlyph } from "../../shared/types.js";
import { sessionShortId } from "../../shared/utils/hash.js";

export type { ProjectButton, RecentButton } from "../../core/projects/project-ops.js";
export type { SessionEntry } from "../../core/read/transcript.js";

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
  | { kind: "inputslist"; sid: string }
  | { kind: "delmode" }
  | { kind: "dellist" }
  | { kind: "listalive" }
  | { kind: "newfree" }
  | { kind: "newfreecancel" }
  | { kind: "queuestatus" }
  | { kind: "recoverlist" }
  | { kind: "recover" }
  | { kind: "recovercancel" }
  | { kind: "voicelang"; lang: string }
  | { kind: "uilang"; lang: Lang }
  | { kind: "resume"; sessionId: string }
  | { kind: "inputredo"; token: string; idx: number }
  | { kind: "startpick"; idx: number; sid: string }
  | { kind: "restartpick"; idx: number; sid: string }
  | { kind: "qcancel"; sid: string; msgId: string }
  | { kind: "adoptshow"; pid: number }
  | { kind: "adoptexec"; pid: number; target: "path" | "free" }
  | { kind: "adoptcancel" }
  | { kind: "adoptattach"; sid: string }
  | { kind: "statusinstall"; action: StatusInstallAction }
  | { kind: "browse"; action: BrowseAction }
  | { kind: "browseselect" }
  | { kind: "browsenewfolder" }
  | { kind: "browsecancel" }
  | { kind: "apPanel"; sid: string }
  | { kind: "apToggle"; sid: string }
  | { kind: "apGlobal"; sid: string; on: boolean }
  | { kind: "apStop"; sid: string }
  | { kind: "apBack"; sid: string }
  | { kind: "apPick"; sid: string }
  | { kind: "apGoalToggle"; sid: string; idx: number }
  | { kind: "apRounds"; sid: string; delta: number }
  | { kind: "apStart"; sid: string }
  | { kind: "apConfirm"; sid: string }
  | { kind: "apContinue"; sid: string }
  | { kind: "promptget"; sid: string }
  | { kind: "promptfilter"; tagSid: string }
  | { kind: "promptpage"; page: number; tagSid: string };

/** The choices when /status_install hits a foreign statusLine. */
export const STATUS_INSTALL_ACTIONS = ["overwrite", "wrap", "snippet", "skip"] as const;
export type StatusInstallAction = (typeof STATUS_INSTALL_ACTIONS)[number];

export function encodeControlAction(action: string, sid: string): string {
  return `a:${action}:${sid}`;
}

type SidKind = "switch" | "remove" | "more" | "less" | "add" | "peek" | "history" | "inputslist";
const SID_TAGS: Record<string, SidKind> = {
  s: "switch",
  r: "remove",
  m: "more",
  l: "less",
  g: "add",
  ins: "inputslist",
  pk: "peek",
  hi: "history",
};

export function parseCallbackData(data: string): CallbackAction | null {
  // Argument-less toggles / views.
  if (data === "dm") return { kind: "delmode" };
  if (data === "dl") return { kind: "dellist" };
  if (data === "la") return { kind: "listalive" };
  if (data === "nf") return { kind: "newfree" };
  if (data === "nfx") return { kind: "newfreecancel" };
  if (data === "qs") return { kind: "queuestatus" };
  if (data === "ac") return { kind: "adoptcancel" };
  if (data === "rcv") return { kind: "recoverlist" };
  if (data === "rec") return { kind: "recover" };
  if (data === "recx") return { kind: "recovercancel" };
  const parts = data.split(":");
  const [tag] = parts;
  if (tag === "pp") {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: "promptget", sid };
  }
  if (tag === "pf") {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: "promptfilter", tagSid: sid };
  }
  if (tag === "pn") {
    const page = Number(parts[1]);
    const tagSid = parts[2] ?? "_";
    if (parts.length !== 3 || !Number.isInteger(page) || page < 0) return null;
    return { kind: "promptpage", page, tagSid: tagSid === "_" ? "" : tagSid };
  }
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
  if (tag === "rs") {
    const sessionId = parts[1];
    if (!sessionId) return null;
    return { kind: "resume", sessionId };
  }
  if (tag === "inp") {
    const token = parts[1];
    const idx = Number(parts[2]);
    if (parts.length !== 3 || !token || !Number.isInteger(idx) || idx < 0) return null;
    return { kind: "inputredo", token, idx };
  }
  if (tag === "sp" || tag === "rp") {
    const idx = Number(parts[1]);
    const sid = parts[2];
    if (parts.length !== 3 || !Number.isInteger(idx) || idx < 0 || !sid) return null;
    return { kind: tag === "rp" ? "restartpick" : "startpick", idx, sid };
  }
  if (tag === "qx") {
    // Cancel a still-queued message: qx:<sid>:<msgId> (msgId has no ':').
    const sid = parts[1];
    const msgId = parts[2];
    if (parts.length !== 3 || !sid || !msgId) return null;
    return { kind: "qcancel", sid, msgId };
  }
  if (tag === "as" || tag === "ae" || tag === "af") {
    const pid = Number(parts[1]);
    if (parts.length !== 2 || !Number.isInteger(pid) || pid <= 0) return null;
    if (tag === "as") return { kind: "adoptshow", pid };
    return { kind: "adoptexec", pid, target: tag === "af" ? "free" : "path" };
  }
  if (tag === "aa") {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: "adoptattach", sid };
  }
  if (tag === "si") {
    const a = parts[1];
    if (parts.length !== 2 || !STATUS_INSTALL_ACTIONS.includes(a as StatusInstallAction))
      return null;
    return { kind: "statusinstall", action: a as StatusInstallAction };
  }
  if (tag === "ap") {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: "apPanel", sid };
  }
  if (tag === "apt" || tag === "apstop" || tag === "apl") {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    const kind = tag === "apt" ? "apToggle" : tag === "apstop" ? "apStop" : "apBack";
    return { kind, sid } as CallbackAction;
  }
  if (tag === "apglobal") {
    const on = parts[1];
    const sid = parts[2];
    if (parts.length !== 3 || (on !== "1" && on !== "0") || !sid) return null;
    return { kind: "apGlobal", sid, on: on === "1" };
  }
  if (tag === "apg" || tag === "apgo") {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: tag === "apg" ? "apPick" : "apStart", sid };
  }
  if (tag === "apgt") {
    const idx = Number(parts[1]);
    const sid = parts[2];
    if (parts.length !== 3 || !Number.isInteger(idx) || idx < 0 || !sid) return null;
    return { kind: "apGoalToggle", sid, idx };
  }
  if (tag === "apr") {
    const delta = Number(parts[1]);
    const sid = parts[2];
    if (parts.length !== 3 || (delta !== 1 && delta !== -1) || !sid) return null;
    return { kind: "apRounds", sid, delta };
  }
  if (tag === "apc" || tag === "apx") {
    const sid = parts[1];
    if (parts.length !== 2 || !sid) return null;
    return { kind: tag === "apc" ? "apConfirm" : "apContinue", sid };
  }
  if (tag === "br") return parseBrowseData(parts);
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

/** Parse a `br:*` directory-browser callback. `cd`/`rt`/`pg` carry an index; the
 * argument-less `up`/`sel`/`x` are navigation-up / select-here / cancel. */
function parseBrowseData(parts: string[]): CallbackAction | null {
  const sub = parts[1];
  if (parts.length === 2) {
    if (sub === "up") return { kind: "browse", action: { kind: "up" } };
    if (sub === "sel") return { kind: "browseselect" };
    if (sub === "nf") return { kind: "browsenewfolder" };
    if (sub === "x") return { kind: "browsecancel" };
    return null;
  }
  if (parts.length !== 3) return null;
  const n = Number(parts[2]);
  if (!Number.isInteger(n) || n < 0) return null;
  if (sub === "cd") return { kind: "browse", action: { kind: "open", index: n } };
  if (sub === "rt") return { kind: "browse", action: { kind: "root", index: n } };
  if (sub === "pg") return { kind: "browse", action: { kind: "page", page: n } };
  return null;
}

/**
 * Directory-browser keyboard: one button per subdir (tap to descend, or to pick a
 * root on the roots screen), then an up/pagination row and a create/cancel row.
 * Paths never ride in callback_data (64-byte cap) — buttons carry the action +
 * the entry's absolute index, resolved against the scope's server-side cwd.
 */
export function buildBrowseKeyboard(view: BrowseView): InlineKeyboard {
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  const tag = view.kind === "roots" ? "rt" : "cd";
  for (const e of view.entries) {
    // 📦 marks a git repo (a likely project root); 📁 a plain directory.
    kb.text(`${e.isRepo ? "📦" : "📁"} ${e.label}`, `br:${tag}:${e.index}`).row();
  }
  let navRow = false;
  if (view.canGoUp) {
    kb.text(m.btnBrowseUp, "br:up");
    navRow = true;
  }
  if (view.totalPages > 1) {
    const prev = Math.max(0, view.page - 1);
    const next = Math.min(view.totalPages - 1, view.page + 1);
    kb.text("◀", `br:pg:${prev}`)
      .text(`${view.page + 1}/${view.totalPages}`, "noop")
      .text("▶", `br:pg:${next}`);
    navRow = true;
  }
  if (navRow) kb.row();
  if (view.canCreate) {
    kb.text(m.btnBrowseCreate, "br:sel").row().text(m.btnBrowseNewFolder, "br:nf");
  }
  kb.text(m.btnBrowseCancel, "br:x");
  return kb;
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

/** Pick-a-start keyboard: one button per configured start command (shown when
 * more than one is configured). Tapping sends `sp:<idx>:<sid>`. */
export function buildStartPickerKeyboard(
  commands: { label: string; command?: string; agent?: "claude" | "codex" }[],
  sid: string,
  mode: "start" | "restart" = "start",
): InlineKeyboard {
  const prefix = mode === "restart" ? "rp" : "sp";
  const kb = new InlineKeyboard();
  commands.forEach((c, i) => {
    const glyph = agentGlyph(c.agent ?? "claude");
    kb.text(`${glyph} ${c.label}`, `${prefix}:${i}:${sid}`);
    if (i < commands.length - 1) kb.row();
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

/** A lone ❌ on a "queued" ack, so the user can cancel that still-waiting message
 * before it's typed in. `qx:<sid>:<msgId>` (msgId carries no ':'). */
export function buildQueueCancelKeyboard(sid: string, msgId: string): InlineKeyboard {
  return new InlineKeyboard().text("❌", `qx:${sid}:${msgId}`);
}

/** Idle panel: with no agent running, control keys do nothing — offer the launch
 * and project-navigation actions instead. */
export function buildIdleKeyboard(sid: string): InlineKeyboard {
  const m = messages("telegram");
  return new InlineKeyboard()
    .text(m.btnStart, encodeControlAction("start", sid))
    .row()
    .text(m.btnProjects, "la")
    .text(m.btnRecover, "rcv");
}

/** Collapsed control panel: the always-on interrupts row + views, then "more ▾".
 * When `running` is false the panel adapts to {@link buildIdleKeyboard}. */
export function buildControlKeyboard(sid: string, running = true): InlineKeyboard {
  if (!running) return buildIdleKeyboard(sid);
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  for (const action of CONTROL_INTERRUPTS) {
    const meta = ACTION_META[action];
    if (meta) kb.text(m[meta.btnKey] as string, encodeControlAction(action, sid));
  }
  return kb
    .row()
    .text(m.btnPeek, `pk:${sid}`)
    .text(m.btnHistory, `hi:${sid}`)
    .text(m.btnInputs, `ins:${sid}`)
    .row()
    .text(m.btnProjects, "la")
    .text(m.btnQueue, "qs")
    .row()
    .text(m.btnMore, `m:${sid}`);
}

/** Expanded control panel: the full canonical control rows (interrupts → lifecycle
 * → navigation), then read/views, then project nav, then "collapse". */
export function buildExpandedControlKeyboard(sid: string): InlineKeyboard {
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  addActionRows(kb, CONTROL_ROWS_FULL, sid);
  return kb
    .text(m.btnStatus, encodeControlAction("status", sid))
    .text(m.btnPeek, `pk:${sid}`)
    .text(m.btnHistory, `hi:${sid}`)
    .text(m.btnInputs, `ins:${sid}`)
    .row()
    .text(m.btnProjects, "la")
    .text(m.btnQueue, "qs")
    .text(m.btnRecover, "rcv")
    .row()
    .text("🤖 Autopilot", `ap:${sid}`)
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
  kb.text(messages("telegram").btnNewFree, "nf").row();
  return kb.text(messages("telegram").btnDeleteMode, "dm");
}

/** Lone "🆓 new free project" button — shown when the alive list is empty so the
 * first parallel project is still one tap away. */
export function buildNewFreeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(messages("telegram").btnNewFree, "nf");
}

/** Lone "cancel" button shown under the "name your free project" prompt, so the
 * armed label capture can be dropped without sending a throwaway message. */
export function buildFreeLabelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(messages("telegram").btnCancel, "nfx");
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

function formatAgo(date: Date): string {
  const diffMin = Math.round((Date.now() - date.getTime()) / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.round(diffH / 24)}d`;
}

export type OrphanButton = { pid: number; label: string };

/** Orphan-claude list: one full-width row per process. Tapping sends `as:<pid>`
 * (show a confirm), since the action — interrupting and adopting — is disruptive. */
export function buildOrphanKeyboard(orphans: OrphanButton[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  orphans.forEach((o, i) => {
    kb.text(o.label, `as:${o.pid}`);
    if (i < orphans.length - 1) kb.row();
  });
  return kb;
}

/** Confirm step before reboot recovery: tap to execute (`rec`) or cancel (`recx`). */
export function buildRecoverConfirmKeyboard(): InlineKeyboard {
  const m = messages("telegram");
  return new InlineKeyboard().text(m.btnRecoverConfirm, "rec").text(m.btnCancel, "recx");
}

/** Confirm step before adopting: tap to execute (`ae:<pid>`) or cancel. */
export function buildAdoptConfirmKeyboard(pid: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(messages("telegram").btnAdoptConfirm, `ae:${pid}`)
    .row()
    .text(messages("telegram").btnAdoptAsFree, `af:${pid}`)
    .row()
    .text(messages("telegram").btnAdoptCancel, "ac");
}

/** After a successful adopt: a button that copies the attach command to the
 * computer's clipboard on demand (`aa:<sid>`), for viewing the session there. */
export function buildAdoptDoneKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard().text(messages("telegram").btnAdoptAttach, `aa:${sid}`);
}

/** Choices when /status_install finds a foreign statusLine (`si:<action>`). */
export function buildStatusInstallChoiceKeyboard(): InlineKeyboard {
  const m = messages("telegram");
  return new InlineKeyboard()
    .text(m.btnStatusWrap, "si:wrap")
    .text(m.btnStatusOverwrite, "si:overwrite")
    .row()
    .text(m.btnStatusSnippet, "si:snippet")
    .text(m.btnStatusSkip, "si:skip");
}

/** Session list: one full-width row per saved session. Tapping sends `rs:<uuid>`. */
export function buildSessionsKeyboard(sessions: SessionEntry[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  sessions.forEach((s, i) => {
    const label = `${s.sessionId.slice(0, 8)} · ${formatAgo(s.mtime)}`;
    kb.text(label, `rs:${s.sessionId}`);
    if (i < sessions.length - 1) kb.row();
  });
  return kb;
}

/** Recent-inputs list: one full-width row per input; tapping fetches it back as an
 * editable draft (does NOT auto-send). Buttons carry `inp:<token>:<idx>` resolved
 * against the server-side input cache. */
export function buildInputsKeyboard(prompts: string[], token: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  prompts.forEach((p, i) => {
    kb.text(inputButtonLabel(p, i), `inp:${token}:${i}`).row();
  });
  return kb;
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

/** Goal-cycle picker: every catalog goal as a toggle (✓ when selected), a
 * rounds stepper, and a start button summarising the selection. Goals are keyed
 * by catalog index (apgt:<idx>:<sid>) to fit callback_data. */
export function buildAutopilotGoalPicker(view: AutopilotView, sid: string): InlineKeyboard {
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  view.goals.forEach((g, i) => {
    kb.text(g.selected ? `✓ ${g.title}` : g.title, `apgt:${i}:${sid}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  kb.text(m.btnApRoundsMinus, `apr:-1:${sid}`)
    .text(m.apRoundsLabel(view.rounds), "noop")
    .text(m.btnApRoundsPlus, `apr:1:${sid}`)
    .row();
  const n = view.goals.filter((g) => g.selected).length;
  if (n > 0) kb.text(m.btnApStartCycle(n, view.rounds), `apgo:${sid}`).row();
  return kb.text(m.btnApBack, `ap:${sid}`); // back to the panel
}

/** The two buttons attached to a human-gate push notification. */
export function buildAutopilotGateKeyboard(sid: string): InlineKeyboard {
  const m = messages("telegram");
  return new InlineKeyboard()
    .text(m.btnApConfirm, `apc:${sid}`)
    .text(m.btnApContinue, `apx:${sid}`);
}

/** Autopilot panel: progressive disclosure from the AutopilotView.
 * OFF → a single "enable" button; ON → toggle/pick-goals/global/stop; a pending
 * human gate surfaces confirm/continue at the top. Tapping routes to apt/apg/
 * apglobal/apstop and (gate) apc/apx. */
export function buildAutopilotPanelKeyboard(view: AutopilotView, sid: string): InlineKeyboard {
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  if (view.gatePending) {
    kb.text(m.btnApConfirm, `apc:${sid}`).text(m.btnApContinue, `apx:${sid}`).row();
  }
  if (!view.enabled) {
    return kb.text(m.btnApEnable, `apt:${sid}`).row().text(m.btnApBack, `apl:${sid}`);
  }
  kb.text(m.btnApDisable, `apt:${sid}`).text(m.btnApPickGoals, `apg:${sid}`).row();
  kb.text(
    view.globalOn ? m.btnApGlobalOff : m.btnApGlobalOn,
    `apglobal:${view.globalOn ? 0 : 1}:${sid}`,
  );
  if (view.mode === "cycle") kb.text(m.btnApStop, `apstop:${sid}`);
  return kb.row().text(m.btnApBack, `apl:${sid}`);
}

export { PROMPTS_PAGE_SIZE, type PromptsView } from "../../core/promptlib/view.js";

/** List keyboard: tag-filter row + one button per prompt + paging row. items is current page ≤8 items. */
export function buildPromptsKeyboard(
  items: Array<{ name: string; tags: string[] }>,
  tags: Array<{ tag: string; count: number }>,
  view: PromptsView,
): InlineKeyboard {
  const m = messages("telegram");
  const kb = new InlineKeyboard();
  // Tag filter row (show up to 6 tags + "All" clear)
  const shownTags = tags.slice(0, 6);
  shownTags.forEach((t) => {
    const active = t.tag === view.tagFilter;
    kb.text(`${active ? "✅ " : "🏷 "}${t.tag} (${t.count})`, `pf:${sessionShortId(t.tag)}`);
  });
  if (view.tagFilter) kb.text(m.promptsAll, "pn:0:_");
  if (shownTags.length > 0 || view.tagFilter) kb.row();
  // One button per prompt
  items.forEach((p) => {
    const label = p.tags.length ? `${p.name}  [${p.tags.join(", ")}]` : p.name;
    kb.text(label, `pp:${sessionShortId(p.name)}`).row();
  });
  // Paging row
  const f = view.tagFilter ? sessionShortId(view.tagFilter) : "_";
  if (view.page > 0) kb.text(m.promptsPrev, `pn:${view.page - 1}:${f}`);
  if (view.page < view.totalPages - 1) kb.text(m.promptsNext, `pn:${view.page + 1}:${f}`);
  return kb;
}
