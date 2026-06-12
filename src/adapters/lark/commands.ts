import { getLarkImmediate, getLarkQueued } from "../../core/action-registry.js";
import type { MessageAction } from "../../core/dispatch.js";

export const IMMEDIATE = getLarkImmediate();
export const QUEUED = getLarkQueued();

/** Read-side / project-management commands that render or mutate project state
 * rather than driving the Claude session. */
export type ViewName =
  | "peek"
  | "history"
  | "listalive"
  | "recent"
  | "queuestatus"
  | "current"
  | "addproject"
  | "voicelang"
  | "uilang"
  | "ws"
  | "sessions"
  | "doctor";

/** Slash token → ViewName. `/list_alive_projects` etc. are spelled out so the
 * Lark command surface matches Telegram's. */
const VIEW_COMMANDS: Record<string, ViewName> = {
  peek: "peek",
  history: "history",
  list_alive_projects: "listalive",
  list_recent_projects: "recent",
  queue_status: "queuestatus",
  current_project: "current",
  add_project: "addproject",
  voice_lang: "voicelang",
  lang: "uilang",
  ws: "ws",
  sessions: "sessions",
  doctor: "doctor",
};

export type ParsedInput =
  | { kind: "text"; text: string }
  | { kind: "help" }
  | { kind: "command"; action: MessageAction; immediate: boolean }
  | { kind: "view"; name: ViewName; arg?: string | undefined }
  | { kind: "unknown"; name: string };

export function parseLarkInput(raw: string): ParsedInput {
  const trimmed = raw.trim();

  if (!trimmed.startsWith("/")) {
    return { kind: "text", text: trimmed };
  }

  // First whitespace-delimited token (original case), then strip `/` + lowercase
  // for the command name. Slice the arg by the TOKEN's length — not indexOf(name),
  // which returns -1 for a mixed/upper-case command and corrupts the path.
  const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
  const name = firstToken.slice(1).toLowerCase();
  // Everything after the first token, preserved verbatim (e.g. the add_project path).
  const arg = trimmed.slice(firstToken.length).trim() || undefined;

  if (name === "help") {
    return { kind: "help" };
  }

  if (IMMEDIATE.has(name as MessageAction)) {
    return { kind: "command", action: name as MessageAction, immediate: true };
  }

  if (QUEUED.has(name as MessageAction)) {
    return { kind: "command", action: name as MessageAction, immediate: false };
  }

  const view = VIEW_COMMANDS[name];
  if (view) {
    return { kind: "view", name: view, arg };
  }

  return { kind: "unknown", name };
}
