import {
  ACTION_META,
  buildHelpBody,
  LARK_CONTROL_ROWS,
  LARK_HELP_RUNNING_ROWS,
} from "../../core/action-registry.js";
import type { MessageAction } from "../../core/dispatch.js";
import { type Lang, messages, UI_LANGS } from "../../core/i18n/index.js";
import type { ProjectButton, RecentButton } from "../../core/project-ops.js";
import { VOICE_LANGS } from "../../core/voice-support.js";
import { signValue } from "./card-signing.js";

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
  behaviors: [{ type: "callback", value: signValue(value) }],
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
  const mv = messages("lark");
  return shell(mv.voiceLangTitle, [
    md(mv.voiceLangCardPrompt(current === "auto" ? mv.autoDetect : current)),
    gridRow(
      VOICE_LANGS.map((l) =>
        l.code === current
          ? { text: `✅ ${l.label}`, value: { cmd: "noop" } }
          : { text: l.label, value: { cmd: "voicelang", lang: l.code } },
      ),
    ),
  ]);
}

/** UI-language picker — mirrors voiceLangCard. Tapping sends `uilang` with the
 * chosen Lang; the title/prompt render in the channel's CURRENT language. */
export function langCard(current: Lang): object {
  const m = messages("lark");
  const label = UI_LANGS.find((l) => l.code === current)?.label ?? current;
  return shell(m.uiLangTitle, [
    md(m.uiLangCurrent(label)),
    gridRow(
      UI_LANGS.map((l) =>
        l.code === current
          ? { text: `✅ ${l.label}`, value: { cmd: "noop" } }
          : { text: l.label, value: { cmd: "uilang", lang: l.code } },
      ),
    ),
  ]);
}

/**
 * The control panel stamped on every result/view card. Feishu has neither
 * Telegram's "/" command discovery nor a reliable expand/collapse (updateCard is
 * unreliable for 2.0 cards), so this carries the high-frequency controls inline
 * rather than the collapsed subset — `enter`/`interrupt`/`restart` included.
 * `start` lives on the recovery card; `up`/`down`/`exit` + the language pickers
 * stay in /help.
 */
function actionRow(actions: MessageAction[]): ButtonSpec[] {
  const m = messages("lark");
  return actions.map((action) => {
    const meta = ACTION_META[action]!;
    return {
      text: m[meta.btnKey] as string,
      value: { cmd: action },
      ...(meta.larkStyle ? { style: meta.larkStyle } : {}),
    };
  });
}

function controlRows(): ButtonSpec[][] {
  return [
    ...LARK_CONTROL_ROWS.map(actionRow),
    [
      { text: messages("lark").btnPeek, value: { cmd: "peek" } },
      { text: messages("lark").btnHistory, value: { cmd: "history" } },
      { text: messages("lark").btnQueue, value: { cmd: "queuestatus" } },
    ],
    [
      { text: messages("lark").btnProjects, value: { cmd: "listalive" } },
      { text: messages("lark").btnCurrent, value: { cmd: "current" } },
      { text: messages("lark").btnHelp, value: { cmd: "help" } },
    ],
  ];
}

export function controlActions(): object[] {
  return controlRows().map(gridRow);
}

/**
 * A dead-end recovery card: the message plus Claude-lifecycle buttons
 * (start/exit) on top of the normal controls, so a "not running" / error reply
 * stays actionable in Feishu without having to type a command.
 */
export function recoveryCard(body: string, title = "⚠️"): object {
  const m = messages("lark");
  return shell(title, [
    md(body),
    HR,
    gridRow([
      { text: m.btnStart, value: { cmd: "start" }, style: "primary" },
      { text: m.btnExit, value: { cmd: "exit" } },
    ]),
    ...controlActions(),
  ]);
}

/** A Claude-result card: the output (or placeholder), the 7 control shortcuts,
 * and a help button. The title carries the 📂 project so the user sees which
 * session answered. */
export function resultCard(output: string, title = "Claude"): object {
  const body = output && output.trim() ? output : messages("lark").emptyOutput;
  return shell(title, [md(body), HR, ...controlActions()]);
}

/** A read-only view card (peek / history): a title, the body, then the same
 * control buttons the result card carries. */
export function viewCard(title: string, body: string): object {
  const content = body && body.trim() ? body : messages("lark").emptyPane;
  return shell(title, [md(content), HR, ...controlActions()]);
}

/** Alive-project list: one labelled row per project with switch/remove buttons
 * (the active one shows an inert "current" marker). */
export function projectListCard(projects: ProjectButton[]): object {
  if (projects.length === 0) {
    return shell(messages("lark").aliveListTitle(0), [md(messages("lark").aliveListEmpty)]);
  }
  const m = messages("lark");
  const elements: object[] = [];
  for (const p of projects) {
    elements.push(md(p.label));
    if (p.active) {
      elements.push(gridRow([{ text: m.btnActiveMarker, value: { cmd: "noop" } }]));
    } else {
      elements.push(
        gridRow([
          { text: m.btnSwitch, value: { cmd: "switch", sid: p.sid } },
          { text: m.btnRemove, value: { cmd: "remove", sid: p.sid }, style: "danger" },
        ]),
      );
    }
  }
  return shell(messages("lark").aliveListTitle(projects.length), elements);
}

/** Recent-project list: per project, tap an alive one to switch, a stopped one
 * to (re)create it; the active one is inert. */
export function recentListCard(projects: RecentButton[]): object {
  if (projects.length === 0) {
    return shell(messages("lark").recentListTitle, [md(messages("lark").recentListEmpty)]);
  }
  const m = messages("lark");
  const elements: object[] = [];
  for (const p of projects) {
    elements.push(md(p.label));
    if (p.active) {
      elements.push(gridRow([{ text: m.btnActiveMarker, value: { cmd: "noop" } }]));
    } else if (p.alive) {
      elements.push(gridRow([{ text: m.btnSwitch, value: { cmd: "switch", sid: p.sid } }]));
    } else {
      elements.push(gridRow([{ text: m.btnCreate, value: { cmd: "addrecent", sid: p.sid } }]));
    }
  }
  return shell(messages("lark").recentListTitle, elements);
}

/** The interactive /help menu card: a button for every command. */
export function helpCard(): object {
  const m = messages("lark");
  return shell(m.helpTitle, [
    md(buildHelpBody("lark", "lark")),
    HR,
    md(m.helpRunning),
    ...LARK_HELP_RUNNING_ROWS.map((row) => gridRow(actionRow(row))),
    HR,
    md(m.helpProjects),
    gridRow([
      { text: m.btnPeek, value: { cmd: "peek" } },
      { text: m.btnHistory, value: { cmd: "history" } },
      { text: m.btnQueue, value: { cmd: "queuestatus" } },
    ]),
    gridRow([
      { text: m.btnProjects, value: { cmd: "listalive" } },
      { text: m.btnRecent, value: { cmd: "recent" } },
      { text: m.btnCurrent, value: { cmd: "current" } },
    ]),
    gridRow([
      { text: m.btnVoiceLang, value: { cmd: "voicelangmenu" } },
      { text: m.btnUiLang, value: { cmd: "uilangmenu" } },
    ]),
  ]);
}
