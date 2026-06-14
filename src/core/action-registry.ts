/**
 * Single source of truth for action metadata and UI layout.
 *
 * To add a new command:
 *   1. dispatch.ts   — add to MESSAGE_ACTIONS + add a case (execution logic)
 *   2. action-registry.ts — add to ACTION_META + relevant button row group(s)
 *   3. catalog/*.ts  — add btnXxx + cmdXxx keys to zh.ts (canonical), then every
 *                      other language (en/zh-TW/yue/ja/es) — a missing key fails the build
 *   Everything else updates automatically:
 *     • lark/commands.ts  IMMEDIATE / QUEUED sets
 *     • telegram/handlers.ts  bot.command() registrations
 *     • telegram/keyboards.ts  keyboard layouts
 *     • lark/cards.ts  control panel + help card buttons
 *     • command-catalog.ts  Telegram BOT_COMMANDS + help text
 */

import type { BotCommand } from "../shared/types.js";
import type { MessageAction } from "./dispatch.js";
import type { Messages } from "./i18n/catalog/zh.js";
import { messages } from "./i18n/index.js";

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

// ── Button row groups ────────────────────────────────────────────────────────
// Inner array = one button row. Edit these to reposition buttons across ALL surfaces.

/** Primary Telegram inline keyboard rows (always visible beneath results). */
export const TELEGRAM_PRIMARY_ROWS: MessageAction[][] = [
  ["enter", "interrupt"],
  ["esc", "restart"],
];

/** Single action row for the collapsed Telegram control keyboard. */
export const TELEGRAM_COLLAPSED_ROW: MessageAction[] = ["esc", "clear", "compact"];

/** Additional rows shown in the expanded Telegram control keyboard. */
export const TELEGRAM_EXPANDED_ROWS: MessageAction[][] = [
  ["clear", "compact"],
  ["up", "down", "left", "right", "tab"],
  ["exit", "status"],
];

/** Action rows for the Lark inline control panel (stamped on every card). */
export const LARK_CONTROL_ROWS: MessageAction[][] = [
  ["esc", "enter", "interrupt"],
  ["clear", "compact", "restart"],
];

/** Action rows for the Lark /help card "running" section. */
export const LARK_HELP_RUNNING_ROWS: MessageAction[][] = [
  ["enter", "esc", "interrupt"],
  ["restart", "clear", "compact"],
  ["up", "down", "left", "right", "tab", "status"],
  ["start", "exit"],
];

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

const PROJECTS: readonly HelpRow[] = [
  [{ cmds: ["current_project"], descKey: "cmdCurrentProject" }],
  [{ cmds: ["list_alive_projects"], descKey: "cmdListAlive" }],
  [{ cmds: ["list_recent_projects"], descKey: "cmdListRecent" }],
  [{ cmds: ["add_project"], descKey: "cmdAddProject", argHint: " <path>" }],
  [{ cmds: ["adopt"], descKey: "cmdAdopt" }],
  [{ cmds: ["queue_status"], descKey: "cmdQueueStatus" }],
  [{ cmds: ["history"], descKey: "cmdHistory", argHint: " [N]" }],
  [{ cmds: ["sessions"], descKey: "cmdSessions" }],
];

const RUNNING: readonly HelpRow[] = [
  [
    { cmds: ["enter"], descKey: "cmdEnter" },
    { cmds: ["esc"], descKey: "cmdEsc" },
  ],
  [
    { cmds: ["interrupt"], descKey: "cmdInterrupt" },
    { cmds: ["restart"], descKey: "cmdRestart" },
  ],
  [
    { cmds: ["clear"], descKey: "cmdClear" },
    { cmds: ["compact"], descKey: "cmdCompact" },
  ],
  [
    { cmds: ["up", "down", "left", "right", "tab"], descKey: "cmdArrowsTab" },
    { cmds: ["exit"], descKey: "cmdExit" },
  ],
];

const TELEGRAM_SECTIONS: readonly HelpSection[] = [
  { headerKey: "helpSectionProjects", rows: PROJECTS },
  { headerKey: "helpSectionRunning", rows: RUNNING },
  {
    headerKey: "helpSectionIdle",
    rows: [
      [{ cmds: ["start"], descKey: "cmdStart" }],
      [{ cmds: ["peek"], descKey: "cmdPeek" }],
      [{ cmds: ["status"], descKey: "cmdStatus" }],
      [{ cmds: ["doctor"], descKey: "cmdDoctor" }],
      [{ cmds: ["help"], descKey: "cmdHelp" }],
    ],
  },
];

const LARK_SECTIONS: readonly HelpSection[] = [
  {
    headerKey: "helpSectionProjects",
    rows: [
      ...PROJECTS,
      [{ cmds: ["peek"], descKey: "cmdPeek" }],
      [{ cmds: ["voice_lang"], descKey: "cmdVoiceLang" }],
      [{ cmds: ["lang"], descKey: "cmdLang" }],
    ],
  },
  {
    headerKey: "helpSectionRunning",
    rows: [...RUNNING, [{ cmds: ["status"], descKey: "cmdStatus" }]],
  },
  {
    headerKey: "helpSectionIdle",
    rows: [
      [{ cmds: ["start"], descKey: "cmdStart" }],
      [{ cmds: ["doctor"], descKey: "cmdDoctor" }],
      [{ cmds: ["help"], descKey: "cmdHelp" }],
    ],
  },
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
  const sections = adapter === "telegram" ? TELEGRAM_SECTIONS : LARK_SECTIONS;

  const body = sections
    .map((section) => {
      const header = `━━ ${m[section.headerKey] as string} ━━`;
      const rows = section.rows.map((row) => renderRow(row, m, "    "));
      return [header, ...rows].join("\n");
    })
    .join("\n\n");

  return `${intro}\n\n${body}`;
}

// ── Telegram BOT_COMMANDS ────────────────────────────────────────────────────

export const BOT_COMMANDS: BotCommand[] = [
  { command: "help", description: "Show all commands" },
  { command: "start", description: "Start Claude" },
  { command: "status", description: "Check Claude status" },
  { command: "peek", description: "Capture tmux pane" },
  { command: "esc", description: "Send Escape key" },
  { command: "interrupt", description: "Send Ctrl-C" },
  { command: "clear", description: "Send /clear command" },
  { command: "compact", description: "Send /compact command" },
  { command: "enter", description: "Send Enter key" },
  { command: "up", description: "Send Up arrow" },
  { command: "down", description: "Send Down arrow" },
  { command: "left", description: "Send Left arrow" },
  { command: "right", description: "Send Right arrow" },
  { command: "tab", description: "Send Tab key" },
  { command: "exit", description: "Exit Claude" },
  { command: "restart", description: "Restart Claude with --continue" },
  { command: "list_alive_projects", description: "List alive projects" },
  { command: "list_recent_projects", description: "List recent projects" },
  { command: "current_project", description: "Show current project" },
  { command: "add_project", description: "Add a new project" },
  { command: "adopt", description: "Take over a Claude running outside tmux" },
  { command: "queue_status", description: "Show message queue status" },
  {
    command: "history",
    description: "Show recent conversation history (default: last, /history N for Nth recent)",
  },
  { command: "doctor", description: "Run install health checks" },
  { command: "voice_install", description: "Install voice transcription (Apple Silicon)" },
  { command: "voice_lang", description: "Set voice recognition language (zh/en/yue/ja/es/auto)" },
  { command: "lang", description: "Set interface language (en/zh/zh-TW/yue/ja/es)" },
];
