import {
  ACTION_META,
  buildHelpBody,
  LARK_CONTROL_ROWS,
  LARK_HELP_RUNNING_ROWS,
} from "../../core/action-registry.js";
import type { BrowseView } from "../../core/dir-browser.js";
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

/** Voice-not-installed prompt with a one-tap install button. Feishu has no "/"
 * command discovery, so the in-chat install is a button (mirrors Telegram's
 * `/voice_install`). Sent when a voice message arrives but whisper isn't ready. */
export function voiceInstallCard(): object {
  const mv = messages("lark");
  return shell("🎙️", [
    md(mv.voiceNotInstalled),
    gridRow([{ text: mv.btnVoiceInstall, value: { cmd: "voiceinstall" }, style: "primary" }]),
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

function controlRows(group = false): ButtonSpec[][] {
  const m = messages("lark");
  // A bound project group is pinned to one workspace, so cross-project
  // management (list-all/switch/remove) doesn't belong there — only the work
  // surface for the pinned project. Drop the "Projects" entry in groups.
  const lastRow: ButtonSpec[] = group
    ? [
        { text: m.btnCurrent, value: { cmd: "current" } },
        { text: m.btnHelp, value: { cmd: "help" } },
      ]
    : [
        { text: m.btnProjects, value: { cmd: "listalive" } },
        { text: m.btnAdoptConfirm, value: { cmd: "adoptlist" } },
        { text: m.btnCurrent, value: { cmd: "current" } },
        { text: m.btnHelp, value: { cmd: "help" } },
      ];
  return [
    ...LARK_CONTROL_ROWS.map(actionRow),
    [
      { text: m.btnPeek, value: { cmd: "peek" } },
      { text: m.btnHistory, value: { cmd: "history" } },
      { text: m.btnQueue, value: { cmd: "queuestatus" } },
    ],
    lastRow,
  ];
}

export function controlActions(group = false): object[] {
  return controlRows(group).map(gridRow);
}

/**
 * A dead-end recovery card: the message plus Claude-lifecycle buttons
 * (start/exit) on top of the normal controls, so a "not running" / error reply
 * stays actionable in Feishu without having to type a command.
 */
export function recoveryCard(body: string, group = false, title = "⚠️"): object {
  const m = messages("lark");
  return shell(title, [
    md(body),
    HR,
    gridRow([
      { text: m.btnStart, value: { cmd: "start" }, style: "primary" },
      { text: m.btnExit, value: { cmd: "exit" } },
    ]),
    ...controlActions(group),
  ]);
}

/** Pick-a-start card: one button per configured start command (shown when more
 * than one is configured). Each carries its index back as `startpick`. */
export function startPickerCard(
  commands: { label: string; command: string }[],
  mode: "start" | "restart" = "start",
): object {
  const m = messages("lark");
  const cmd = mode === "restart" ? "restartpick" : "startpick";
  const elements: object[] = [md(m.startPickerPrompt)];
  commands.forEach((c, i) => {
    elements.push(md(`**${c.label}**\n\`${c.command}\``));
    elements.push(gridRow([{ text: m.btnStartThis, value: { cmd, idx: i }, style: "primary" }]));
  });
  return shell(m.startPickerTitle, elements);
}

/** A Claude-result card: the output (or placeholder), the 7 control shortcuts,
 * and a help button. The title carries the 📂 project so the user sees which
 * session answered. */
export function resultCard(output: string, title = "Claude", group = false): object {
  const body = output && output.trim() ? output : messages("lark").emptyOutput;
  return shell(title, [md(body), HR, ...controlActions(group)]);
}

/** A read-only view card (peek / history): a title, the body, then the same
 * control buttons the result card carries. */
export function viewCard(title: string, body: string, group = false): object {
  const content = body && body.trim() ? body : messages("lark").emptyPane;
  return shell(title, [md(content), HR, ...controlActions(group)]);
}

/** Usage-reporting install result. When a foreign statusLine was found, offers
 * the wrap / overwrite / snippet / skip choice (mirrors Telegram's si:<action>). */
export function statusInstallCard(body: string, foreignPending: boolean): object {
  const m = messages("lark");
  const elements: object[] = [md(body)];
  if (foreignPending) {
    elements.push(
      gridRow([
        { text: m.btnStatusWrap, value: { cmd: "statuswrap" }, style: "primary" },
        { text: m.btnStatusOverwrite, value: { cmd: "statusoverwrite" } },
      ]),
      gridRow([
        { text: m.btnStatusSnippet, value: { cmd: "statussnippet" } },
        { text: m.btnStatusSkip, value: { cmd: "statusskip" } },
      ]),
    );
  }
  return shell(m.statusInstallTitle, elements);
}

/**
 * Directory browser: one row per subdir (tap to descend, or pick a root on the
 * roots screen), an up/pagination row, then a create/cancel row. Mirrors the
 * Telegram browse keyboard; paths never ride in the (signed) button value — only
 * the action + the entry's absolute index, resolved against the scope's cwd.
 */
export function browseCard(view: BrowseView): object {
  const m = messages("lark");
  const title = view.kind === "roots" ? m.browseRootsTitle : m.browseTitle;
  const elements: object[] = [];
  if (view.kind === "dir") {
    const note =
      view.error === "unreadable"
        ? `\n${m.browseUnreadable}`
        : view.entries.length === 0
          ? `\n${m.browseEmpty}`
          : "";
    elements.push(md(`\`${view.displayPath}\`${note}`));
  }
  const cmd = view.kind === "roots" ? "browseroot" : "browseopen";
  for (const e of view.entries) {
    // 📦 marks a git repo (a likely project root); 📁 a plain directory.
    const icon = e.isRepo ? "📦" : "📁";
    elements.push(gridRow([{ text: `${icon} ${e.label}`, value: { cmd, idx: e.index } }]));
  }
  const nav: ButtonSpec[] = [];
  if (view.canGoUp) nav.push({ text: m.btnBrowseUp, value: { cmd: "browseup" } });
  if (view.totalPages > 1) {
    nav.push({ text: "◀", value: { cmd: "browsepage", idx: Math.max(0, view.page - 1) } });
    nav.push({ text: `${view.page + 1}/${view.totalPages}`, value: { cmd: "noop" } });
    nav.push({
      text: "▶",
      value: { cmd: "browsepage", idx: Math.min(view.totalPages - 1, view.page + 1) },
    });
  }
  if (nav.length > 0) elements.push(gridRow(nav));
  if (view.canCreate) {
    elements.push(
      gridRow([
        { text: m.btnBrowseCreate, value: { cmd: "browsecreate" }, style: "primary" },
        { text: m.btnBrowseNewFolder, value: { cmd: "browsenewfolder" } },
      ]),
    );
  }
  elements.push(gridRow([{ text: m.btnBrowseCancel, value: { cmd: "browsecancel" } }]));
  return shell(title, elements);
}

/** Adopt list: one labelled row per non-tmux claude with a "take over" button
 * (`adopt` → shows a confirm). Mirrors Telegram's `/adopt` keyboard. */
export function orphanListCard(orphans: { pid: number; label: string }[]): object {
  const m = messages("lark");
  return listCard(m.adoptTitle, m.adoptEmpty, orphans, (o) =>
    gridRow([{ text: m.btnAdoptConfirm, value: { cmd: "adopt", pid: o.pid }, style: "primary" }]),
  );
}

/** Confirm step before adopting: tap to execute (`adoptgo`) or cancel. */
export function adoptConfirmCard(pid: number, label: string): object {
  const m = messages("lark");
  return shell(m.adoptTitle, [
    md(m.adoptConfirmPrompt(label)),
    gridRow([
      { text: m.btnAdoptConfirm, value: { cmd: "adoptgo", pid }, style: "primary" },
      { text: m.btnAdoptCancel, value: { cmd: "adoptcancel" } },
    ]),
  ]);
}

/** After a successful adopt: the result plus a button that copies the attach
 * command to the host clipboard on demand (`adoptattach`). */
export function adoptDoneCard(body: string, sid: string): object {
  const m = messages("lark");
  return shell("✅", [
    md(body),
    gridRow([{ text: m.btnAdoptAttach, value: { cmd: "adoptattach", sid } }]),
  ]);
}

/** Elements for a tappable project list: an empty-state message, or a labelled
 * row + a `rowFor(p)` button row per project. Reused by listCard and the
 * group-overview card's picker section. */
function listElements<P extends { label: string }>(
  emptyMsg: string,
  projects: readonly P[],
  rowFor: (p: P) => object | null,
): object[] {
  if (projects.length === 0) return [md(emptyMsg)];
  const elements: object[] = [];
  for (const p of projects) {
    elements.push(md(p.label));
    const row = rowFor(p);
    if (row) elements.push(row);
  }
  return elements;
}

/** Shared skeleton for the tappable project lists: an empty-state message, or a
 * labelled row + a `rowFor(p)` button row per project, under one title. */
function listCard<P extends { label: string }>(
  title: string,
  emptyMsg: string,
  projects: readonly P[],
  rowFor: (p: P) => object | null,
): object {
  return shell(title, listElements(emptyMsg, projects, rowFor));
}

/** Alive-project list: one labelled row per project with switch/remove buttons
 * (the active one shows an inert "current" marker). In a bound group the list
 * is read-only — switch/remove are private-chat-only, so non-active rows carry
 * no buttons and the delete button can never be rendered there. */
export function projectListCard(projects: ProjectButton[], group = false): object {
  const m = messages("lark");
  return listCard(m.aliveListTitle(projects.length), m.aliveListEmpty, projects, (p) => {
    if (p.active) return gridRow([{ text: m.btnActiveMarker, value: { cmd: "noop" } }]);
    if (group) return null;
    return gridRow([
      { text: m.btnSwitch, value: { cmd: "switch", sid: p.sid } },
      { text: m.btnRemove, value: { cmd: "remove", sid: p.sid }, style: "danger" },
    ]);
  });
}

/** Recent-project list: per project, tap an alive one to switch, a stopped one
 * to (re)create it; the active one is inert. */
export function recentListCard(projects: RecentButton[], group = false): object {
  const m = messages("lark");
  return listCard(m.recentListTitle, m.recentListEmpty, projects, (p) => {
    if (p.active) return gridRow([{ text: m.btnActiveMarker, value: { cmd: "noop" } }]);
    if (group) return null; // read-only in a group: switching/creating is private-chat-only
    if (p.alive) return gridRow([{ text: m.btnSwitch, value: { cmd: "switch", sid: p.sid } }]);
    return gridRow([{ text: m.btnCreate, value: { cmd: "addrecent", sid: p.sid } }]);
  });
}

/** Project-group picker: list recent projects, each with a "new group" (p2p) or
 * "bind" (in a group) button carrying the project's short id. No typing needed. */
export function groupPickerCard(projects: RecentButton[], mode: "make" | "bind" | "free"): object {
  const m = messages("lark");
  const title =
    mode === "make"
      ? m.groupPickerTitle
      : mode === "bind"
        ? m.groupBindPickerTitle
        : m.groupFreePickerTitle;
  const text = mode === "make" ? m.btnMakeGroup : mode === "bind" ? m.btnBindHere : m.btnFreeGroup;
  const cmd = mode === "make" ? "makegroup" : mode === "bind" ? "bindhere" : "makefreegroup";
  return listCard(title, m.groupMenuNoProjects, projects, (p) =>
    gridRow([{ text, value: { cmd, sid: p.sid } }]),
  );
}

/** Bound-group management card: restore / rebind / unbind, no typing needed. */
export function groupBoundCard(label: string): object {
  const m = messages("lark");
  return shell(m.groupBoundCardTitle(label), [
    md(m.groupBoundCardTitle(label)),
    gridRow([
      { text: m.btnRestoreGroup, value: { cmd: "restore" }, style: "primary" },
      { text: m.btnRebindGroup, value: { cmd: "rebind" } },
      { text: m.btnUnbindGroup, value: { cmd: "unbind" }, style: "danger" },
    ]),
  ]);
}

/** From a private chat: the project-group overview — the existing groups (label
 * + workspace path) plus a picker of recent projects that don't yet have a group
 * (each with a "new group" button). Lets you SEE your groups, not just create. */
export function groupOverviewCard(
  groups: ReadonlyArray<{ label: string; workspacePath: string }>,
  projects: RecentButton[],
): object {
  const m = messages("lark");
  const elements: object[] = [md(m.groupOverviewExisting)];
  if (groups.length === 0) {
    elements.push(md(m.groupOverviewNoGroups));
  } else {
    for (const g of groups) elements.push(md(m.groupOverviewItem(g.label, g.workspacePath)));
  }
  elements.push(
    HR,
    md(m.groupPickerTitle),
    ...listElements(m.groupMenuNoProjects, projects, (p) =>
      gridRow([{ text: m.btnMakeGroup, value: { cmd: "makegroup", sid: p.sid } }]),
    ),
  );
  return shell(m.groupOverviewTitle, elements);
}

/** The interactive /help menu card: a button for every command. When voice is
 *  installable (supported host, not yet installed) a one-tap install button is
 *  surfaced — the discoverable counterpart of Telegram's `/voice_install`. */
export function helpCard(group = false, voiceInstallable = false): object {
  const m = messages("lark");
  // In a bound group, drop cross-project management (list-all / recent / make
  // group); a group is pinned to one project. Keep the work-surface views.
  const projectRow: ButtonSpec[] = group
    ? [{ text: m.btnCurrent, value: { cmd: "current" } }]
    : [
        { text: m.btnAddProject, value: { cmd: "addproject" } },
        { text: m.btnProjects, value: { cmd: "listalive" } },
        { text: m.btnRecent, value: { cmd: "recent" } },
        { text: m.btnAdoptConfirm, value: { cmd: "adoptlist" } },
        { text: m.btnCurrent, value: { cmd: "current" } },
      ];
  const prefsRow: ButtonSpec[] = group
    ? [
        { text: m.btnVoiceLang, value: { cmd: "voicelangmenu" } },
        { text: m.btnUiLang, value: { cmd: "uilangmenu" } },
      ]
    : [
        { text: m.btnGroupMenu, value: { cmd: "groupmenu" } },
        { text: m.btnFreeGroup, value: { cmd: "freegroupmenu" } },
        { text: m.btnVoiceLang, value: { cmd: "voicelangmenu" } },
        { text: m.btnUiLang, value: { cmd: "uilangmenu" } },
      ];
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
    gridRow(projectRow),
    ...(group ? [] : [gridRow([{ text: m.btnStatusInstall, value: { cmd: "statusinstall" } }])]),
    ...(voiceInstallable
      ? [gridRow([{ text: m.btnVoiceInstall, value: { cmd: "voiceinstall" }, style: "primary" }])]
      : []),
    gridRow(prefsRow),
  ]);
}
