/**
 * Single source of truth for action metadata and UI layout.
 *
 * To add a new command:
 *   1. dispatch.ts   — add to MESSAGE_ACTIONS + add a case (execution logic)
 *   2. action-registry.ts — add to ACTION_META + relevant button row group(s),
 *                      and to BOT_COMMANDS below (the Telegram command menu — a
 *                      hand-maintained array in this file)
 *   3. catalog/*.ts  — add btnXxx + cmdXxx keys to zh.ts (canonical), then every
 *                      other language (en/zh-TW/yue/ja/es) — a missing key fails the build
 *   Everything else updates automatically:
 *     • lark/commands.ts  IMMEDIATE / QUEUED sets
 *     • telegram/handlers.ts  bot.command() registrations
 *     • telegram/keyboards.ts  keyboard layouts
 *     • lark/cards.ts  control panel + help card buttons
 */

import type { BotCommand } from "../../shared/types.js";
import type { Messages } from "../i18n/catalog/zh.js";
import { messages } from "../i18n/index.js";
import type { MessageAction } from "./dispatch.js";

type StringKey = { [K in keyof Messages]: Messages[K] extends string ? K : never }[keyof Messages];

// ── Per-action metadata ──────────────────────────────────────────────────────

export interface ActionMeta {
  btnKey: StringKey;
  /** null = no Lark slash command (action only reachable via button) */
  larkKind: "immediate" | "queued" | null;
  /** true = register as Telegram bot.command() */
  telegram: boolean;
  /** Lark-only button style override */
  larkStyle?: "danger" | "primary";
}

/** Metadata for every action that has a button or slash-command surface. */
export const ACTION_META: Partial<Record<MessageAction, ActionMeta>> = {
  enter: { btnKey: "btnEnter", larkKind: "immediate", telegram: true },
  esc: { btnKey: "btnEsc", larkKind: "immediate", telegram: true },
  interrupt: { btnKey: "btnInterrupt", larkKind: "immediate", telegram: true, larkStyle: "danger" },
  restart: { btnKey: "btnRestart", larkKind: "queued", telegram: true },
  clear: { btnKey: "btnClear", larkKind: "immediate", telegram: true },
  compact: { btnKey: "btnCompact", larkKind: "immediate", telegram: true },
  up: { btnKey: "btnUp", larkKind: "immediate", telegram: true },
  down: { btnKey: "btnDown", larkKind: "immediate", telegram: true },
  left: { btnKey: "btnLeft", larkKind: "immediate", telegram: true },
  right: { btnKey: "btnRight", larkKind: "immediate", telegram: true },
  tab: { btnKey: "btnTab", larkKind: "immediate", telegram: true },
  exit: { btnKey: "btnExit", larkKind: "queued", telegram: true },
  status: { btnKey: "btnStatus", larkKind: "immediate", telegram: true },
  start: { btnKey: "btnStart", larkKind: "queued", telegram: true, larkStyle: "primary" },
  // "text" — no button, not a slash command
};

// ── Canonical agent-control button layout ────────────────────────────────────
// ONE ordering, the single source for every control surface — Telegram's expanded
// panel, Lark's control card, and both help cards all render these rows in this
// order, so the surfaces can no longer drift. Telegram's COLLAPSED panel shows
// just the interrupts row + a "more ▾" toggle; expanding reveals the rest.
// Grouped by purpose: interrupts (mid-task essentials) → lifecycle → navigation.

/** Always-visible mid-task controls (also the Telegram collapsed row). */
export const CONTROL_INTERRUPTS: MessageAction[] = ["esc", "enter", "interrupt"];
/** Agent lifecycle. */
export const CONTROL_LIFECYCLE: MessageAction[] = ["restart", "clear", "compact", "exit"];
/** TUI navigation keys (rarely needed → only in the expanded / help surfaces). */
export const CONTROL_NAV: MessageAction[] = ["up", "down", "left", "right", "tab"];

/** Full control rows for the expanded Telegram panel and the Lark control card. */
export const CONTROL_ROWS_FULL: MessageAction[][] = [
  CONTROL_INTERRUPTS,
  CONTROL_LIFECYCLE,
  CONTROL_NAV,
];

/** Agent-action button rows for the help card "Session" section (adds start/status). */
export const HELP_SESSION_ROWS: MessageAction[][] = [...CONTROL_ROWS_FULL, ["start", "status"]];

// ── Derived sets / lists ─────────────────────────────────────────────────────

/**
 * Actions that bypass the queue and run immediately (keypresses, status).
 * Channel-neutral: both adapters share the same immediate/queued split, so the
 * Telegram executor and the Lark command router both derive from this — neither
 * hardcodes its own list (which drifted historically: telegram once omitted
 * `tab`). Modeled under `larkKind` for legacy reasons; the concept is universal.
 */
export function getImmediateActions(): Set<MessageAction> {
  return new Set(
    (Object.entries(ACTION_META) as [MessageAction, ActionMeta][])
      .filter(([, m]) => m.larkKind === "immediate")
      .map(([a]) => a),
  );
}

export function getLarkQueued(): Set<MessageAction> {
  return new Set(
    (Object.entries(ACTION_META) as [MessageAction, ActionMeta][])
      .filter(([, m]) => m.larkKind === "queued")
      .map(([a]) => a),
  );
}

/** MessageActions that should be registered as Telegram bot.command() handlers. */
export function getTelegramActions(): MessageAction[] {
  return (Object.entries(ACTION_META) as [MessageAction, ActionMeta][])
    .filter(([, m]) => m.telegram)
    .map(([a]) => a);
}

// ── Help text builder ────────────────────────────────────────────────────────

interface HelpItem {
  cmds: string[];
  descKey: StringKey;
  argHint?: string;
}

type HelpRow = readonly [HelpItem] | readonly [HelpItem, HelpItem];

interface HelpSection {
  headerKey: StringKey;
  rows: readonly HelpRow[];
}

// One taxonomy for both adapters: Session → Projects → Settings → Diagnostics
// (matching the / menu grouping and the help-card sections). Each command lives in
// exactly one category, so a user can predict where to find it.

const SESSION: readonly HelpRow[] = [
  [
    { cmds: ["start"], descKey: "cmdStart" },
    { cmds: ["status"], descKey: "cmdStatus" },
  ],
  [
    { cmds: ["peek"], descKey: "cmdPeek", argHint: " [N]" },
    { cmds: ["history"], descKey: "cmdHistory", argHint: " [N]" },
  ],
  [{ cmds: ["inputs"], descKey: "cmdInputs", argHint: " [N]" }],
  [
    { cmds: ["restart"], descKey: "cmdRestart" },
    { cmds: ["exit"], descKey: "cmdExit" },
  ],
  [
    { cmds: ["clear"], descKey: "cmdClear" },
    { cmds: ["compact"], descKey: "cmdCompact" },
  ],
  [
    { cmds: ["esc"], descKey: "cmdEsc" },
    { cmds: ["interrupt"], descKey: "cmdInterrupt" },
  ],
  [
    { cmds: ["enter"], descKey: "cmdEnter" },
    { cmds: ["up", "down", "left", "right", "tab"], descKey: "cmdArrowsTab" },
  ],
];

const PROJECTS: readonly HelpRow[] = [
  [{ cmds: ["current_project"], descKey: "cmdCurrentProject" }],
  [{ cmds: ["list_alive_projects"], descKey: "cmdListAlive" }],
  [{ cmds: ["list_recent_projects"], descKey: "cmdListRecent" }],
  [{ cmds: ["sessions"], descKey: "cmdSessions" }],
  [{ cmds: ["add_project"], descKey: "cmdAddProject", argHint: " <path>" }],
  [{ cmds: ["new_free"], descKey: "cmdNewFree", argHint: " [label]" }],
  [{ cmds: ["adopt"], descKey: "cmdAdopt" }],
  [{ cmds: ["recover"], descKey: "cmdRecover" }],
];

const SETTINGS: readonly HelpRow[] = [
  [{ cmds: ["lang"], descKey: "cmdLang" }],
  [{ cmds: ["voice_lang"], descKey: "cmdVoiceLang" }],
  [{ cmds: ["voice_install"], descKey: "cmdVoiceInstall" }],
  [{ cmds: ["status_install"], descKey: "cmdStatusInstall" }],
];

const DIAGNOSTICS: readonly HelpRow[] = [
  [{ cmds: ["batch"], descKey: "cmdBatch", argHint: " [start <id>|pause|resume|stop|report]" }],
  [{ cmds: ["dashboard"], descKey: "cmdDashboard" }],
  [{ cmds: ["sysload"], descKey: "cmdSysload" }],
  [{ cmds: ["logs"], descKey: "cmdLogs", argHint: " [traceId|N]" }],
  [{ cmds: ["queue_status"], descKey: "cmdQueueStatus" }],
  [{ cmds: ["doctor"], descKey: "cmdDoctor" }],
  [{ cmds: ["help"], descKey: "cmdHelp" }],
];

const SECTIONS: readonly HelpSection[] = [
  { headerKey: "helpSectionSession", rows: SESSION },
  { headerKey: "helpSectionProjects", rows: PROJECTS },
  { headerKey: "helpSectionSettings", rows: SETTINGS },
  { headerKey: "helpSectionDiagnostics", rows: DIAGNOSTICS },
];

function renderItem(item: HelpItem, m: Messages): string {
  const cmds = item.cmds
    .map((c, i) => `/${c}${i === item.cmds.length - 1 && item.argHint ? item.argHint : ""}`)
    .join(" · ");
  return `${cmds} — ${m[item.descKey] as string}`;
}

function renderRow(row: HelpRow, m: Messages, sep: string): string {
  return (row as readonly HelpItem[]).map((item) => renderItem(item, m)).join(sep);
}

export function buildHelpBody(adapter: "telegram" | "lark", channel: "telegram" | "lark"): string {
  const m = messages(channel);
  const intro = adapter === "telegram" ? m.helpIntroTelegram : m.helpIntroLark;

  const body = SECTIONS.map((section) => {
    const header = `━━ ${m[section.headerKey] as string} ━━`;
    const rows = section.rows.map((row) => renderRow(row, m, "    "));
    return [header, ...rows].join("\n");
  }).join("\n\n");

  return `${intro}\n\n${body}`;
}

// ── Telegram BOT_COMMANDS ────────────────────────────────────────────────────

// The `/` autocomplete menu, grouped by category (Session → Projects → Settings →
// Diagnostics). Deliberately OMITS the pure button keys (esc/interrupt/enter/up/
// down/left/right/tab) — nobody types `/up`, and they flood the menu. Their
// bot.command() handlers stay registered (getTelegramActions), so typing them
// still works; they're just not advertised. Reachable as one-tap control buttons.
export const BOT_COMMANDS: BotCommand[] = [
  // ▶️ Session
  { command: "help", description: "Show all commands" },
  { command: "start", description: "Start the agent" },
  { command: "status", description: "Check agent status" },
  { command: "peek", description: "Capture the tmux pane (/peek N for N lines of scrollback)" },
  {
    command: "history",
    description: "Show recent conversation history (default: last, /history N for Nth recent)",
  },
  { command: "inputs", description: "List your recent inputs — tap one to fetch & edit it" },
  { command: "restart", description: "Restart the agent (resumes the conversation)" },
  { command: "clear", description: "Send /clear command" },
  { command: "compact", description: "Send /compact command" },
  { command: "exit", description: "Exit the agent" },
  // 📂 Projects
  { command: "current_project", description: "Show current project" },
  { command: "list_alive_projects", description: "List alive projects" },
  { command: "list_recent_projects", description: "List recent projects" },
  { command: "sessions", description: "List resumable agent sessions" },
  { command: "add_project", description: "Add a new project" },
  { command: "new_free", description: "Create a free (parallel) project" },
  { command: "adopt", description: "Take over an agent running outside tmux" },
  { command: "recover", description: "Recover all projects after a reboot (recreate + relaunch)" },
  // ⚙️ Settings
  { command: "lang", description: "Set interface language (en/zh/zh-TW/yue/ja/es)" },
  { command: "voice_lang", description: "Set voice recognition language (zh/en/yue/ja/es/auto)" },
  { command: "voice_install", description: "Install voice transcription (Apple Silicon)" },
  {
    command: "status_install",
    description: "Install usage reporting (statusLine snapshot) for /status",
  },
  // 🛠 Diagnostics
  {
    command: "batch",
    description: "Batch scheduler status or control (/batch start <id>|pause|resume|stop|report)",
  },
  { command: "autopilot", description: "Toggle/inspect keep-alive autopilot for this session" },
  { command: "goals", description: "List autopilot goal presets" },
  { command: "dashboard", description: "Show the global dashboard (all sessions overview)" },
  { command: "sysload", description: "Show machine load, heat, and runaway processes" },
  {
    command: "logs",
    description: "Show recent WARN/ERROR logs (/logs <traceId> or /logs N)",
  },
  { command: "queue_status", description: "Show message queue status" },
  { command: "doctor", description: "Run install health checks" },
];
