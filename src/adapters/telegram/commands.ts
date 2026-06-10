import type { BotCommand } from "../../shared/types.js";

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
