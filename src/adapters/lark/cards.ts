import type { ProjectButton, RecentButton } from "../../core/project-ops.js";
import { VOICE_LANGS } from "../../core/voice-support.js";
import { HELP_TEXT } from "./commands.js";

/** A card button spec. `value` is echoed back in cardAction.action.value. */
interface ButtonSpec {
  text: string;
  value: object;
  style?: string;
}

// --- Feishu card schema 2.0 primitives ---
// v1 cards stack `action`-element buttons one-per-row on some clients; only a
// 2.0 `column_set` with the buttons placed DIRECTLY in columns lays them out
// side by side. (v1 forbids buttons in a column — API error 200410.)

const md = (content: string): object => ({ tag: "markdown", content });

const button = ({ text, value, style }: ButtonSpec): object => ({
  tag: "button",
  text: { tag: "plain_text", content: text },
  type: style ?? "default",
  behaviors: [{ type: "callback", value }],
});

/** One row of buttons as a column_set — each button in its own auto-width column
 * so they sit side by side. Each Telegram keyboard row maps to one gridRow, so
 * the layout matches `buildControlKeyboard` row-for-row. */
const gridRow = (btns: ButtonSpec[]): object => ({
  tag: "column_set",
  flex_mode: "flow",
  horizontal_spacing: "small",
  columns: btns.map((b) => ({
    tag: "column",
    width: "auto",
    elements: [button(b)],
  })),
});

const HR = { tag: "hr" } as const;

const shell = (title: string, elements: object[]): object => ({
  schema: "2.0",
  config: { summary: { content: title } },
  header: { title: { tag: "plain_text", content: title } },
  body: { elements },
});

/** Voice recognition-language picker — mirrors Telegram's button picker. The
 * active language is marked and inert; tapping another sends `voicelang` with the
 * chosen code. The recognition language is per-channel — this sets Feishu's only. */
export function voiceLangCard(current: string): object {
  return shell("🎙️ 语音识别语言", [
    md(`当前(飞书)：**${current === "auto" ? "自动检测" : current}** · 点按钮切换`),
    gridRow(
      VOICE_LANGS.map((l) =>
        l.code === current
          ? { text: `✅ ${l.label}`, value: { cmd: "noop" } }
          : { text: l.label, value: { cmd: "voicelang", lang: l.code } },
      ),
    ),
  ]);
}

/** Collapsed (default) control rows — mirrors Telegram `buildControlKeyboard`
 * row-for-row: esc/clear/compact · peek/历史 · 项目/队列. */
const CONTROL_COLLAPSED_ROWS: ButtonSpec[][] = [
  [
    { text: "⎋ Esc", value: { cmd: "esc" } },
    { text: "🧹 clear", value: { cmd: "clear" } },
    { text: "🗜 compact", value: { cmd: "compact" } },
  ],
  [
    { text: "👁 peek", value: { cmd: "peek" } },
    { text: "📜 历史", value: { cmd: "history" } },
  ],
  [
    { text: "📁 项目", value: { cmd: "listalive" } },
    { text: "📋 队列", value: { cmd: "queuestatus" } },
  ],
];

/**
 * The control panel: one grid row per Telegram keyboard row (the 7 collapsed
 * controls), then a 💡 帮助 button. (An expand/collapse toggle was dropped —
 * Feishu's in-place card update via updateCard isn't reliable for 2.0 cards, so
 * the full control set lives in the /help card instead.)
 */
export function controlActions(): object[] {
  const help: ButtonSpec = { text: "💡 帮助", value: { cmd: "help" } };
  return [...CONTROL_COLLAPSED_ROWS.map(gridRow), gridRow([help])];
}

/** A Claude-result card: the output (or placeholder), the 7 control shortcuts,
 * and a 帮助 button. The title carries the 📂 project so the user sees which
 * session answered. */
export function resultCard(output: string, title = "Claude"): object {
  const body = output && output.trim() ? output : "(无输出)";
  return shell(title, [md(body), HR, ...controlActions()]);
}

/** A read-only view card (peek / history): a title, the body, then the same
 * control buttons the result card carries. */
export function viewCard(title: string, body: string): object {
  const content = body && body.trim() ? body : "(空)";
  return shell(title, [md(content), HR, ...controlActions()]);
}

/** Alive-project list: one labelled row per project with switch/remove buttons
 * (the active one shows an inert "当前" marker). */
export function projectListCard(projects: ProjectButton[]): object {
  if (projects.length === 0) {
    return shell("活跃项目 (0)", [md("没有活跃项目，用 /add_project <路径> 新建")]);
  }
  const elements: object[] = [];
  for (const p of projects) {
    elements.push(md(p.label));
    if (p.active) {
      elements.push(gridRow([{ text: "✅ 当前", value: { cmd: "noop" } }]));
    } else {
      elements.push(
        gridRow([
          { text: "🔀 切换", value: { cmd: "switch", sid: p.sid } },
          { text: "🗑 删除", value: { cmd: "remove", sid: p.sid }, style: "danger" },
        ]),
      );
    }
  }
  return shell(`活跃项目 (${projects.length})`, elements);
}

/** Recent-project list: per project, tap an alive one to switch, a stopped one
 * to (re)create it; the active one is inert. */
export function recentListCard(projects: RecentButton[]): object {
  if (projects.length === 0) {
    return shell("近期项目", [md("没有近期项目，用 /add_project <路径> 添加")]);
  }
  const elements: object[] = [];
  for (const p of projects) {
    elements.push(md(p.label));
    if (p.active) {
      elements.push(gridRow([{ text: "✅ 当前", value: { cmd: "noop" } }]));
    } else if (p.alive) {
      elements.push(gridRow([{ text: "🔀 切换", value: { cmd: "switch", sid: p.sid } }]));
    } else {
      elements.push(gridRow([{ text: "➕ 创建", value: { cmd: "addrecent", sid: p.sid } }]));
    }
  }
  return shell("近期项目", elements);
}

/** The interactive /help menu card: a button for every command. */
export function helpCard(): object {
  return shell("使用帮助", [
    md(HELP_TEXT),
    HR,
    md("**⚡ 运行中**"),
    gridRow([
      { text: "⏎ 回车", value: { cmd: "enter" } },
      { text: "⎋ Esc", value: { cmd: "esc" } },
      { text: "✋ 中断", value: { cmd: "interrupt" }, style: "danger" },
    ]),
    gridRow([
      { text: "🔄 重启", value: { cmd: "restart" } },
      { text: "🧹 clear", value: { cmd: "clear" } },
      { text: "🗜 compact", value: { cmd: "compact" } },
    ]),
    gridRow([
      { text: "⬆️ up", value: { cmd: "up" } },
      { text: "⬇️ down", value: { cmd: "down" } },
      { text: "📊 状态", value: { cmd: "status" } },
    ]),
    gridRow([
      { text: "🚀 启动", value: { cmd: "start" }, style: "primary" },
      { text: "🚪 退出", value: { cmd: "exit" } },
    ]),
    HR,
    md("**📂 项目 / 视图**"),
    gridRow([
      { text: "👁 peek", value: { cmd: "peek" } },
      { text: "📜 历史", value: { cmd: "history" } },
      { text: "📋 队列", value: { cmd: "queuestatus" } },
    ]),
    gridRow([
      { text: "📁 项目", value: { cmd: "listalive" } },
      { text: "🕘 近期", value: { cmd: "recent" } },
      { text: "📌 当前", value: { cmd: "current" } },
    ]),
    gridRow([{ text: "🎙️ 语音语言", value: { cmd: "voicelangmenu" } }]),
  ]);
}
