import type { MessageAction } from "../../core/dispatch.js";

export const HELP_TEXT = `\
🤖 tmux-claude (Lark)

发任意文字 → 转给 Claude → 返回结果

━━ 📂 项目 ━━
/current_project — 当前项目
/list_alive_projects — 活跃项目（点按切换/删除）
/list_recent_projects — 近期项目
/add_project <路径> — 新建项目
/queue_status — 队列状态
/history [N] — 对话历史（默认最近一条）
/peek — 查看 tmux 画面

━━ ⚡ 运行中 ━━
/enter — 回车   /esc — Escape
/interrupt — Ctrl-C   /restart — 重启
/clear — 清空上下文   /compact — 压缩
/up · /down — 方向键   /exit — 退出
/status — 状态

━━ 🚀 未运行 ━━
/start — 启动 Claude
/help — 本帮助`;

export const IMMEDIATE = new Set<MessageAction>([
  "esc",
  "interrupt",
  "status",
  "up",
  "down",
  "enter",
  "clear",
  "compact",
]);

export const QUEUED = new Set<MessageAction>(["start", "restart", "exit"]);

/** Read-side / project-management commands that render or mutate project state
 * rather than driving the Claude session. */
export type ViewName =
  | "peek"
  | "history"
  | "listalive"
  | "recent"
  | "queuestatus"
  | "current"
  | "addproject";

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

  // Take the first whitespace-delimited token, strip leading `/`, lowercase
  const name = (trimmed.split(/\s+/)[0] ?? trimmed).slice(1).toLowerCase();
  // Everything after the first token, preserved verbatim (e.g. the add_project path).
  const arg = trimmed.slice(trimmed.indexOf(name) + name.length).trim() || undefined;

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
