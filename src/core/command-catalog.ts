/**
 * Single source of truth for the help text layout.
 *
 * Each HelpRow is one display line; a row has 1 or 2 HelpItems.
 * Two items are rendered side-by-side (e.g. "/enter — Enter    /esc — Escape").
 * A single item with multiple cmds renders them joined with " · ".
 *
 * To add a command:
 *   1. Add a row to the relevant section below.
 *   2. Add a `cmdXxx` description key to zh/en/yue i18n catalogs.
 *   Done — help text and BOT_COMMANDS update automatically.
 */

import type { BotCommand } from "../shared/types.js";
import type { Messages } from "./i18n/catalog/zh.js";
import { messages } from "./i18n/index.js";

type StringKey = { [K in keyof Messages]: Messages[K] extends string ? K : never }[keyof Messages];

interface HelpItem {
  cmds: string[];
  descKey: StringKey;
  argHint?: string; // appended to the last cmd, e.g. " <path>"
}

type HelpRow = readonly [HelpItem] | readonly [HelpItem, HelpItem];

interface HelpSection {
  headerKey: StringKey;
  rows: readonly HelpRow[];
}

// ── Shared row groups ────────────────────────────────────────────────────────

const PROJECTS: readonly HelpRow[] = [
  [{ cmds: ["current_project"], descKey: "cmdCurrentProject" }],
  [{ cmds: ["list_alive_projects"], descKey: "cmdListAlive" }],
  [{ cmds: ["list_recent_projects"], descKey: "cmdListRecent" }],
  [{ cmds: ["add_project"], descKey: "cmdAddProject", argHint: " <path>" }],
  [{ cmds: ["queue_status"], descKey: "cmdQueueStatus" }],
  [{ cmds: ["history"], descKey: "cmdHistory", argHint: " [N]" }],
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
    { cmds: ["up", "down", "tab"], descKey: "cmdArrowsTab" },
    { cmds: ["exit"], descKey: "cmdExit" },
  ],
];

// ── Per-adapter section layouts ──────────────────────────────────────────────

const TELEGRAM_SECTIONS: readonly HelpSection[] = [
  { headerKey: "helpSectionProjects", rows: PROJECTS },
  { headerKey: "helpSectionRunning", rows: RUNNING },
  {
    headerKey: "helpSectionIdle",
    rows: [
      [{ cmds: ["start"], descKey: "cmdStart" }],
      [{ cmds: ["peek"], descKey: "cmdPeek" }],
      [{ cmds: ["status"], descKey: "cmdStatus" }],
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
    rows: [[{ cmds: ["start"], descKey: "cmdStart" }], [{ cmds: ["help"], descKey: "cmdHelp" }]],
  },
];

// ── Renderer ─────────────────────────────────────────────────────────────────

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
  const rowSep = "    ";

  const body = sections
    .map((section) => {
      const header = `━━ ${m[section.headerKey] as string} ━━`;
      const rows = section.rows.map((row) => renderRow(row, m, rowSep));
      return [header, ...rows].join("\n");
    })
    .join("\n\n");

  return `${intro}\n\n${body}`;
}

// ── Telegram BotFather command list ──────────────────────────────────────────
// English only — Telegram API doesn't support per-language command descriptions.

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
  { command: "tab", description: "Send Tab key" },
  { command: "exit", description: "Exit Claude" },
  { command: "restart", description: "Restart Claude with --continue" },
  { command: "list_alive_projects", description: "List alive projects" },
  { command: "list_recent_projects", description: "List recent projects" },
  { command: "current_project", description: "Show current project" },
  { command: "add_project", description: "Add a new project" },
  { command: "queue_status", description: "Show message queue status" },
  {
    command: "history",
    description: "Show recent conversation history (default: last, /history N for Nth recent)",
  },
  { command: "voice_install", description: "Install voice transcription (Apple Silicon)" },
  { command: "voice_lang", description: "Set voice recognition language (zh/en/auto)" },
  { command: "lang", description: "Set interface language (zh/en)" },
];
