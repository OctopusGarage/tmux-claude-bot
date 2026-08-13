import type { BotCommand } from "../../shared/types.js";
import type { Messages } from "../i18n/catalog/zh.js";
import { messages } from "../i18n/index.js";

type StringKey = { [K in keyof Messages]: Messages[K] extends string ? K : never }[keyof Messages];

interface HelpItem {
  cmds: string[];
  descKey: StringKey;
  argHint?: string;
  telegramDescription?: string;
}

type HelpRow = readonly [HelpItem] | readonly [HelpItem, HelpItem];

interface HelpSection {
  headerKey: StringKey;
  rows: readonly HelpRow[];
}

const SESSION: readonly HelpRow[] = [
  [
    { cmds: ["start"], descKey: "cmdStart", telegramDescription: "Start the agent" },
    { cmds: ["resume"], descKey: "cmdResume", telegramDescription: "Resume the last session" },
  ],
  [{ cmds: ["status"], descKey: "cmdStatus", telegramDescription: "Check agent status" }],
  [
    {
      cmds: ["peek"],
      descKey: "cmdPeek",
      argHint: " [N]",
      telegramDescription: "Capture the session pane (/peek N for N lines of scrollback)",
    },
    {
      cmds: ["history"],
      descKey: "cmdHistory",
      argHint: " [N]",
      telegramDescription:
        "Show recent conversation history (default: last, /history N for Nth recent)",
    },
  ],
  [
    {
      cmds: ["inputs"],
      descKey: "cmdInputs",
      argHint: " [N]",
      telegramDescription: "List your recent inputs - tap one to fetch & edit it",
    },
  ],
  [
    { cmds: ["restart"], descKey: "cmdRestart", telegramDescription: "Restart the agent" },
    { cmds: ["exit"], descKey: "cmdExit", telegramDescription: "Exit the agent" },
  ],
  [
    { cmds: ["clear"], descKey: "cmdClear", telegramDescription: "Send /clear command" },
    { cmds: ["compact"], descKey: "cmdCompact", telegramDescription: "Send /compact command" },
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
  [
    {
      cmds: ["current_project"],
      descKey: "cmdCurrentProject",
      telegramDescription: "Show current project",
    },
  ],
  [
    {
      cmds: ["list_alive_projects"],
      descKey: "cmdListAlive",
      telegramDescription: "List alive projects",
    },
  ],
  [
    {
      cmds: ["list_recent_projects"],
      descKey: "cmdListRecent",
      telegramDescription: "List recent projects",
    },
  ],
  [
    {
      cmds: ["sessions"],
      descKey: "cmdSessions",
      telegramDescription: "List resumable agent sessions",
    },
  ],
  [
    {
      cmds: ["add_project"],
      descKey: "cmdAddProject",
      argHint: " <path>",
      telegramDescription: "Add a new project",
    },
  ],
  [
    {
      cmds: ["new_free"],
      descKey: "cmdNewFree",
      argHint: " [label]",
      telegramDescription: "Create an independent session",
    },
  ],
  [{ cmds: ["adopt"], descKey: "cmdAdopt", telegramDescription: "Take over an unmanaged agent" }],
  [
    {
      cmds: ["recover"],
      descKey: "cmdRecover",
      telegramDescription: "Recover all projects after a reboot",
    },
  ],
];

const SETTINGS: readonly HelpRow[] = [
  [
    {
      cmds: ["home"],
      descKey: "cmdHome",
      telegramDescription: "Switch to the home operator session",
    },
  ],
  [
    {
      cmds: ["lang"],
      descKey: "cmdLang",
      telegramDescription: "Set interface language (en/zh/zh-TW/yue/ja/es)",
    },
  ],
  [
    {
      cmds: ["voice_lang"],
      descKey: "cmdVoiceLang",
      telegramDescription: "Set voice recognition language (zh/en/yue/ja/es/auto)",
    },
  ],
  [
    {
      cmds: ["prompt_translate"],
      descKey: "cmdPromptTranslate",
      telegramDescription: "Set prompt translation (status/off/on from to)",
    },
  ],
  [
    {
      cmds: ["translate_install"],
      descKey: "cmdTranslateInstall",
      telegramDescription: "Install prompt translation dependencies",
    },
  ],
  [
    {
      cmds: ["voice_install"],
      descKey: "cmdVoiceInstall",
      telegramDescription: "Install voice transcription (Apple Silicon)",
    },
  ],
  [
    {
      cmds: ["status_install"],
      descKey: "cmdStatusInstall",
      telegramDescription: "Install usage reporting for /status",
    },
  ],
  [
    {
      cmds: ["prompts"],
      descKey: "cmdPrompts",
      telegramDescription: "Browse saved prompts",
    },
  ],
];

const DIAGNOSTICS: readonly HelpRow[] = [
  [
    {
      cmds: ["autopilot"],
      descKey: "cmdAutopilot",
      argHint: " [requirement]",
      telegramDescription: "Delegate current work to the Loop Supervisor",
    },
  ],
  [
    {
      cmds: ["opportunity"],
      descKey: "cmdOpportunity",
      argHint: " [list|show|discuss|dismiss|snooze <id>]",
      telegramDescription: "Review and discuss proactive opportunity suggestions",
    },
  ],
  [
    {
      cmds: ["dashboard"],
      descKey: "cmdDashboard",
      telegramDescription: "Show the global dashboard",
    },
  ],
  [
    {
      cmds: ["sysload"],
      descKey: "cmdSysload",
      telegramDescription: "Show machine load and Resource Guardian",
    },
  ],
  [
    {
      cmds: ["logs"],
      descKey: "cmdLogs",
      argHint: " [traceId|N]",
      telegramDescription: "Show recent WARN/ERROR logs",
    },
  ],
  [
    {
      cmds: ["queue_status"],
      descKey: "cmdQueueStatus",
      telegramDescription: "Show message queue status",
    },
  ],
  [
    {
      cmds: ["doctor"],
      descKey: "cmdDoctor",
      telegramDescription: "Run install health checks",
    },
  ],
  [{ cmds: ["help"], descKey: "cmdHelp", telegramDescription: "Show all commands" }],
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

function telegramMenuCommands(): BotCommand[] {
  return SECTIONS.flatMap((section) =>
    section.rows.flatMap((row) =>
      (row as readonly HelpItem[]).flatMap((item) => {
        const command = item.cmds[0];
        return item.telegramDescription && command
          ? [{ command, description: item.telegramDescription }]
          : [];
      }),
    ),
  );
}

export const BOT_COMMANDS: BotCommand[] = telegramMenuCommands();
