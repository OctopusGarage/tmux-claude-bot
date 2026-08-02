import {
  actionButtonRows,
  actionConfirmationText,
  actionConfirmButtonText,
  buildHelpBody,
  CONTROL_INTERRUPTS,
  CONTROL_LIFECYCLE,
  HELP_SESSION_ROWS,
} from "../../core/command/action-registry.js";
import type { MessageAction } from "../../core/command/actions.js";
import { type Lang, messages, UI_LANGS } from "../../core/i18n/index.js";
import type { NotificationOpportunity } from "../../core/notifications/gateway.js";
import type { OpportunitySuggestion } from "../../core/opportunities/types.js";
import type { BrowseView } from "../../core/projects/dir-browser.js";
import type { ProjectPickerLikeRow } from "../../core/projects/project-session-picker.js";
import {
  canCreateExistingIndependentGroup,
  projectSessionPrimaryIntent,
} from "../../core/projects/project-session-surface.js";
import { formatProjectSummaryItem } from "../../core/projects/project-summary-view.js";
import type { PromptsView } from "../../core/promptlib/view.js";
import {
  checkPromptTranslateSupport,
  isPromptTranslateInstallable,
  PROMPT_TRANSLATE_SOURCE_PRESETS,
  PROMPT_TRANSLATE_TARGET_LANGUAGE,
  promptTranslateSummary,
  resolvePromptTranslateConfig,
} from "../../core/read/prompt-translation.js";
import { inputButtonLabel } from "../../core/read/recent-inputs.js";
import { checkVoiceSupport, VOICE_LANGS } from "../../core/read/voice-support.js";
import { agentGlyph } from "../../shared/types.js";
import { UI_ICONS } from "../../shared/ui/icons.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { signValue } from "./card-signing.js";

type ProjectButton = ProjectPickerLikeRow;
type RecentButton = ProjectPickerLikeRow;

/** A card button spec. `value` is echoed back in cardAction.action.value. */
interface ButtonSpec {
  text: string;
  value: object;
  style?: string;
  hoverText?: string;
}

// --- Feishu card schema 2.0 primitives ---
// v1 cards stack `action`-element buttons one-per-row on some clients; only a
// 2.0 `column_set` with the buttons placed DIRECTLY in columns lays them out
// side by side. (v1 forbids buttons in a column — API error 200410.)

const md = (content: string): object => ({ tag: "markdown", content });

const button = ({ text, value, style, hoverText }: ButtonSpec): object => ({
  tag: "button",
  text: { tag: "plain_text", content: text },
  type: style ?? "default",
  hover_tips: { tag: "plain_text", content: hoverText ?? text },
  behaviors: [{ type: "callback", value: signValue(value) }],
});

const MAX_BUTTONS_PER_ROW = 3;

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

function gridRows(btns: ButtonSpec[], maxPerRow = MAX_BUTTONS_PER_ROW): object[] {
  const rows: object[] = [];
  for (let i = 0; i < btns.length; i += maxPerRow) {
    rows.push(gridRow(btns.slice(i, i + maxPerRow)));
  }
  return rows;
}

const HR = { tag: "hr" } as const;

const shell = (title: string, elements: object[]): object => ({
  schema: "2.0",
  config: { summary: { content: title } },
  header: { title: { tag: "plain_text", content: title } },
  body: { elements },
});

function opportunityDigestText(opportunity: NotificationOpportunity, index: number): string {
  const sections = [
    `**${index + 1}. ${opportunity.title}**`,
    `_${opportunity.category} · ${opportunity.confidence} confidence · ${opportunity.estimatedComplexity}_`,
    "",
  ];
  if (opportunity.problem?.trim()) {
    sections.push("**Problem:**", opportunity.problem.trim(), "");
  }
  sections.push("**Value:**", opportunity.value.trim());
  if (opportunity.recommendedApproach?.trim()) {
    sections.push("", "**Approach:**", opportunity.recommendedApproach.trim());
  }
  return sections.join("\n");
}

/** Voice recognition-language picker — mirrors Telegram's button picker. The
 * active language is marked and inert; tapping another sends `voicelang` with the
 * chosen code. The recognition language is per-channel — this sets Feishu's only. */
export function voiceLangCard(current: string): object {
  const mv = messages("lark");
  if (!checkVoiceSupport().ready) {
    return voiceInstallCard();
  }
  return shell(mv.voiceLangTitle, [
    md(mv.voiceLangCardPrompt(current === "auto" ? mv.autoDetect : current)),
    ...gridRows(
      VOICE_LANGS.map((l) =>
        l.code === current
          ? { text: `${UI_ICONS.tone.ok} ${l.label}`, value: { cmd: "noop" } }
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
  return shell(UI_ICONS.feature.voice, [
    md(mv.voiceNotInstalled),
    gridRow([{ text: mv.btnVoiceInstall, value: { cmd: "voiceinstall" }, style: "primary" }]),
  ]);
}

function promptTranslateOptionButton(source: string): ButtonSpec {
  const config = resolvePromptTranslateConfig("lark");
  const active =
    config.enabled && config.from === source && config.to === PROMPT_TRANSLATE_TARGET_LANGUAGE;
  const label = `${source}->${PROMPT_TRANSLATE_TARGET_LANGUAGE}`;
  return active
    ? { text: `${UI_ICONS.tone.ok} ${label}`, value: { cmd: "noop" } }
    : {
        text: label,
        value: { cmd: "prompttranslate", arg: `on ${source} ${PROMPT_TRANSLATE_TARGET_LANGUAGE}` },
      };
}

/** Prompt translation picker — mirrors the voice-language card: the current
 * mode is shown in the body, and tapping a source-language preset switches the
 * channel to that translation pair. */
export function promptTranslateCard(): object {
  const m = messages("lark");
  const support = checkPromptTranslateSupport();
  const installRow = isPromptTranslateInstallable()
    ? [
        gridRow([
          {
            text: m.btnPromptTranslateInstall,
            value: { cmd: "translateinstall" },
            style: "primary",
          },
        ]),
      ]
    : [];
  const config = resolvePromptTranslateConfig("lark");
  return shell(m.promptTranslateTitle, [
    md(m.promptTranslateCardPrompt(promptTranslateSummary("lark"))),
    ...(support.ready
      ? [
          gridRow([
            {
              text: config.enabled
                ? m.btnPromptTranslateOff
                : `${UI_ICONS.tone.ok} ${m.btnPromptTranslateOff}`,
              value: { cmd: "prompttranslate", arg: "off" },
            },
          ]),
          ...gridRows(
            PROMPT_TRANSLATE_SOURCE_PRESETS.map((source) => promptTranslateOptionButton(source)),
          ),
        ]
      : []),
    ...installRow,
  ]);
}

/** "Queued" ack carrying a lone cancel button so the user can cancel that still-waiting
 * message before it's typed in. Tapping sends `qcancel` with the session + msgId.
 * (The in-flight ▶ message is already typed — only esc/interrupt stops that.) */
export function queueAckCard(body: string, session: string, msgId: string): object {
  return shell(UI_ICONS.tone.queued, [
    md(body),
    gridRow([{ text: UI_ICONS.tone.error, value: { cmd: "qcancel", s: session, id: msgId } }]),
  ]);
}

export function actionConfirmationCard(
  action: MessageAction,
  target: string,
  group = false,
): object {
  const body = actionConfirmationText(action, "lark", target) ?? action;
  return shell(UI_ICONS.tone.warning, [
    md(body),
    gridRow([
      { text: actionConfirmButtonText(action, "lark"), value: { cmd: "confirm", action } },
      { text: messages("lark").btnCancel, value: { cmd: "noop" } },
    ]),
    HR,
    ...controlActions(group),
  ]);
}

/** UI-language picker — mirrors voiceLangCard. Tapping sends `uilang` with the
 * chosen Lang; the title/prompt render in the channel's CURRENT language. */
export function langCard(current: Lang): object {
  const m = messages("lark");
  const label = UI_LANGS.find((l) => l.code === current)?.label ?? current;
  return shell(m.uiLangTitle, [
    md(m.uiLangCurrent(label)),
    ...gridRows(
      UI_LANGS.map((l) =>
        l.code === current
          ? { text: `${UI_ICONS.tone.ok} ${l.label}`, value: { cmd: "noop" } }
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
  return (actionButtonRows([actions], "lark")[0] ?? []).map((spec) => ({
    text: spec.text,
    value: { cmd: spec.action },
    ...(spec.style ? { style: spec.style } : {}),
  }));
}

function controlRows(group = false, running = true): ButtonSpec[][] {
  const m = messages("lark");
  if (!running) {
    // Idle: no agent — offer launch / navigation instead of dead control keys.
    return [
      [
        { text: m.btnStart, value: { cmd: "start" }, style: "primary" },
        { text: m.btnResume, value: { cmd: "resume" }, style: "primary" },
      ],
      group
        ? [
            { text: m.btnCurrent, value: { cmd: "current" } },
            { text: m.btnHelp, value: { cmd: "help" } },
          ]
        : [
            { text: m.btnProjects, value: { cmd: "listalive" } },
            { text: m.btnRecover, value: { cmd: "recover" } },
            { text: m.btnHelp, value: { cmd: "help" } },
          ],
    ];
  }
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
    // Canonical control rows — SAME order as the Telegram expanded panel
    // (interrupts → lifecycle). `tab` rides the keypress row so it's reachable
    // without opening /help (it's a common autocomplete/confirm key); the arrow
    // nav keys stay help-only so the always-stamped panel doesn't bloat.
    ...[[...CONTROL_INTERRUPTS, "tab" as MessageAction], CONTROL_LIFECYCLE].map(actionRow),
    // Read.
    [
      { text: m.btnPeek, value: { cmd: "peek" } },
      { text: m.btnHistory, value: { cmd: "history" } },
      { text: m.btnInputs, value: { cmd: "inputs" } },
      { text: m.btnStatus, value: { cmd: "status" } },
      { text: m.btnQueue, value: { cmd: "queuestatus" } },
      { text: m.btnApDelegate, value: { cmd: "ap_delegate" }, style: "primary" },
    ],
    // Host-wide ops — p2p only (never leak all-session info / recovery into a group).
    ...(group
      ? []
      : [
          [
            { text: m.btnDashboard, value: { cmd: "dashboard" } },
            { text: m.btnRecover, value: { cmd: "recover" } },
          ],
        ]),
    lastRow,
  ];
}

export function controlActions(group = false, running = true): object[] {
  return controlRows(group, running).flatMap((row) => gridRows(row));
}

/**
 * A dead-end recovery card: the message plus Claude-lifecycle buttons
 * (start/exit) on top of the normal controls, so a "not running" / error reply
 * stays actionable in Feishu without having to type a command.
 */
export function recoveryCard(body: string, group = false, title = UI_ICONS.tone.warning): object {
  const m = messages("lark");
  return shell(title, [
    md(body),
    HR,
    gridRow([
      { text: m.btnStart, value: { cmd: "start" }, style: "primary" },
      { text: m.btnResume, value: { cmd: "resume" }, style: "primary" },
      { text: m.btnExit, value: { cmd: "exit" } },
    ]),
    ...controlActions(group),
  ]);
}

/** Pick-a-start card: one button per configured start command (shown when more
 * than one is configured). Each carries its index back as `startpick`. */
export function startPickerCard(
  commands: { label: string; command: string; agent?: "claude" | "codex" }[],
  mode: "start" | "restart" = "start",
): object {
  const m = messages("lark");
  const cmd = mode === "restart" ? "restartpick" : "startpick";
  const elements: object[] = [md(m.startPickerPrompt)];
  commands.forEach((c, i) => {
    const glyph = agentGlyph(c.agent ?? "claude");
    elements.push(md(`**${glyph} ${c.label}**\n\`${c.command}\``));
    elements.push(gridRow([{ text: m.btnStartThis, value: { cmd, idx: i }, style: "primary" }]));
  });
  return shell(m.startPickerTitle, elements);
}

/** An agent-result card: the output (or placeholder), the 7 control shortcuts,
 * and a help button. The title carries the 📂 project so the user sees which
 * session answered. */
export function resultCard(output: string, title = "Agent", group = false): object {
  const body = output.trim() ? output : messages("lark").emptyOutput;
  return shell(title, [md(body), HR, ...controlActions(group)]);
}

/** A read-only view card (peek / history): a title, the body, then the same
 * control buttons the result card carries. Pass `running=false` to adapt the
 * panel to the idle (launch/navigate) shortcuts. */
export function viewCard(title: string, body: string, group = false, running = true): object {
  const content = body.trim() ? body : messages("lark").emptyPane;
  return shell(title, [md(content), HR, ...controlActions(group, running)]);
}

/** A peek page WITHOUT the control panel — for the non-last chunks of a paged
 * /peek (only the bottom card carries the controls). */
export function peekChunkCard(title: string, body: string): object {
  return shell(title, [md(body.trim() ? body : messages("lark").emptyPane)]);
}

/** Recent-inputs picker: one button per input; tapping fetches it back as an editable
 * draft (does NOT auto-send). Buttons carry `inputredo` + the token/idx into the
 * server-side input cache. */
export function inputsCard(prompts: string[], token: string): object {
  return shell(
    messages("lark").inputsTitle,
    prompts.map((p, i) =>
      gridRow([{ text: inputButtonLabel(p, i), value: { cmd: "inputredo", token, idx: i } }]),
    ),
  );
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
    // Repository icon marks a likely project root; regular-session icon marks a plain directory.
    const icon = e.isRepo ? UI_ICONS.project.repository : UI_ICONS.session.regular;
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
  if (nav.length > 0) elements.push(...gridRows(nav));
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

/** Adopt list: one labelled row per unmanaged claude with a "take over" button
 * (`adopt` → shows a confirm). Mirrors Telegram's `/adopt` keyboard. */
export function orphanListCard(orphans: { pid: number; label: string }[]): object {
  const m = messages("lark");
  return listCard(m.adoptTitle, m.adoptEmpty, orphans, (o) =>
    gridRow([{ text: m.btnAdoptConfirm, value: { cmd: "adopt", pid: o.pid }, style: "primary" }]),
  );
}

/** Confirm step before adopting: tap to execute (`adoptgo`) or cancel. */
/** Confirm step before reboot recovery (mirrors Telegram's /recover preview). */
export function recoverConfirmCard(count: number, alive: number, list: string): object {
  const m = messages("lark");
  return shell("🔄", [
    md(m.recoverPreview(count, alive, list)),
    gridRow([
      { text: m.btnRecoverConfirm, value: { cmd: "recovergo" }, style: "primary" },
      { text: m.btnCancel, value: { cmd: "recovercancel" } },
    ]),
  ]);
}

export function adoptConfirmCard(pid: number, label: string): object {
  const m = messages("lark");
  return shell(m.adoptTitle, [
    md(m.adoptConfirmPrompt(label)),
    ...gridRows([
      { text: m.btnAdoptConfirm, value: { cmd: "adoptgo", pid }, style: "primary" },
      { text: m.btnAdoptAsFree, value: { cmd: "adoptfree", pid } },
      { text: m.btnAdoptCancel, value: { cmd: "adoptcancel" } },
    ]),
  ]);
}

/** After a successful adopt: the result plus a button that copies the attach
 * command to the host clipboard on demand (`adoptattach`). */
export function adoptDoneCard(body: string, sid: string): object {
  const m = messages("lark");
  return shell(UI_ICONS.tone.ok, [
    md(body),
    gridRow([{ text: m.btnAdoptAttach, value: { cmd: "adoptattach", sid } }]),
  ]);
}

export function opportunityDigestCard(input: {
  title: string;
  body: string;
  opportunities: NotificationOpportunity[];
  allowDelegate?: boolean;
}): object {
  const ids = input.opportunities.map((opportunity) => opportunity.id);
  const projectNames = [
    ...new Set(input.opportunities.map((opportunity) => opportunity.projectName)),
  ];
  const projectLabel =
    projectNames.length === 0
      ? "项目"
      : projectNames.length === 1
        ? projectNames[0]
        : `${projectNames.length} 个项目`;
  const elements: object[] = [
    md(
      input.allowDelegate === true
        ? `${projectLabel} · ${input.opportunities.length} 个建议\n可以继续讨论；确认要执行时，请使用 Autopilot 托管。`
        : `${projectLabel} · ${input.opportunities.length} 个建议\n先参与讨论，确认清楚后再托管执行。`,
    ),
  ];
  for (const [index, opportunity] of input.opportunities.entries()) {
    elements.push(HR);
    elements.push(md(opportunityDigestText(opportunity, index)));
    elements.push(
      gridRow([
        { text: "查看详情", value: { cmd: "oppshow", id: opportunity.id } },
        { text: "参与讨论", value: { cmd: "oppdiscuss", id: opportunity.id }, style: "primary" },
        { text: "暂不处理", value: { cmd: "oppdismiss", id: opportunity.id } },
      ]),
    );
  }
  elements.push(
    HR,
    gridRow(
      input.allowDelegate === true
        ? [
            { text: "继续讨论", value: { cmd: "oppdiscussall", ids }, style: "primary" },
            { text: "暂不处理", value: { cmd: "oppdismissall", ids } },
          ]
        : [
            { text: "讨论全部", value: { cmd: "oppdiscussall", ids }, style: "primary" },
            { text: "暂不处理", value: { cmd: "oppdismissall", ids } },
          ],
    ),
  );
  return shell(input.title, elements);
}

export function opportunityDetailCard(
  suggestion: OpportunitySuggestion,
  opts: { allowDelegate?: boolean; title?: string } = {},
): object {
  const buttons: ButtonSpec[] = [
    { text: "参与讨论", value: { cmd: "oppdiscuss", id: suggestion.id }, style: "primary" },
    { text: "暂不处理", value: { cmd: "oppdismiss", id: suggestion.id } },
  ];
  return shell(opts.title ?? suggestion.title, [
    md(
      [
        `**${suggestion.title}**`,
        `ID: ${suggestion.id}`,
        `Project: ${suggestion.projectName}`,
        `Category: ${suggestion.category} · Confidence: ${suggestion.confidence} · Complexity: ${suggestion.estimatedComplexity} · Status: ${suggestion.status}`,
        "",
        "**Problem**",
        suggestion.problem,
        "",
        "**Value**",
        suggestion.value,
        "",
        "**Recommended approach**",
        suggestion.recommendedApproach,
        "",
        "**Acceptance criteria**",
        ...suggestion.acceptanceCriteria.map((item) => `- ${item}`),
        "",
        "**Non-goals**",
        ...suggestion.nonGoals.map((item) => `- ${item}`),
      ].join("\n"),
    ),
    gridRow(buttons),
  ]);
}

/** Elements for a tappable project list: an empty-state message, or a labelled
 * row + a `rowFor(p)` button row per project. Reused by listCard and the
 * group-overview card's picker section. */
function projectListText(p: { label: string; statusLine?: string; path?: string | null }): string {
  return formatProjectSummaryItem(p, {
    boldLabel: Boolean(p.statusLine || p.path),
    markdownPath: true,
  });
}

function listElements<P extends { label: string; statusLine?: string; path?: string | null }>(
  emptyMsg: string,
  projects: readonly P[],
  rowFor: (p: P) => object | null,
): object[] {
  if (projects.length === 0) return [md(emptyMsg)];
  const elements: object[] = [];
  for (const p of projects) {
    elements.push(md(projectListText(p)));
    const row = rowFor(p);
    if (row) elements.push(row);
  }
  return elements;
}

/** Shared skeleton for the tappable project lists: an empty-state message, or a
 * labelled row + a `rowFor(p)` button row per project, under one title. */
function listCard<P extends { label: string; statusLine?: string; path?: string | null }>(
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
    const intent = projectSessionPrimaryIntent(p);
    if (intent.kind !== "switch") {
      const btns: ButtonSpec[] = [{ text: m.btnActiveMarker, value: { cmd: "noop" } }];
      if (!group && canCreateExistingIndependentGroup(p)) {
        btns.push({ text: m.btnMakeGroup, value: { cmd: "makefreeprojectgroup", sid: p.sid } });
      }
      return gridRow(btns);
    }
    if (group) return null;
    const btns: ButtonSpec[] = [{ text: m.btnSwitch, value: { cmd: "switch", sid: intent.sid } }];
    if (canCreateExistingIndependentGroup(p)) {
      btns.push({ text: m.btnMakeGroup, value: { cmd: "makefreeprojectgroup", sid: p.sid } });
    }
    btns.push({ text: m.btnRemove, value: { cmd: "remove", sid: p.sid }, style: "danger" });
    return gridRow(btns);
  });
}

/** Recent-project list: per project, tap an alive one to switch, a stopped one
 * to (re)create it; the active one is inert. */
export function recentListCard(projects: RecentButton[], group = false): object {
  const m = messages("lark");
  return listCard(m.recentListTitle, m.recentListEmpty, projects, (p) => {
    const intent = projectSessionPrimaryIntent(p);
    if (intent.kind === "inert")
      return gridRow([{ text: m.btnActiveMarker, value: { cmd: "noop" } }]);
    if (group) return null; // read-only in a group: switching/creating is private-chat-only
    if (intent.kind === "switch") {
      return gridRow([{ text: m.btnSwitch, value: { cmd: "switch", sid: intent.sid } }]);
    }
    return gridRow([{ text: m.btnCreate, value: { cmd: "addrecent", sid: intent.sid } }]);
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
  const empty =
    mode === "make"
      ? m.groupNoNewGroupProjects
      : mode === "bind"
        ? m.groupNoBindableProjects
        : m.groupNoParallelProjects;
  return listCard(title, empty, projects, (p) => gridRow([{ text, value: { cmd, sid: p.sid } }]));
}

/** Bound-group management card: restore / rebind / unbind, no typing needed. */
export function groupBoundCard(
  label: string,
  details: { statusLine?: string; path?: string | null } = {},
): object {
  const m = messages("lark");
  return shell(m.groupBoundCardTitle(label), [
    md(projectListText({ label, ...details })),
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
  groups: ReadonlyArray<{
    label: string;
    workspacePath: string;
    chatId: string;
    statusLine?: string;
  }>,
  projects: RecentButton[],
): object {
  const m = messages("lark");
  const elements: object[] = [md(m.groupOverviewExisting)];
  if (groups.length === 0) {
    elements.push(md(m.groupOverviewNoGroups));
  } else {
    // Each existing group gets an unbind button — the fallback escape hatch so a
    // stale binding (group left/disbanded, event missed) can be cleared from the
    // private chat without being in the group, then the project rebuilt.
    for (const g of groups) {
      elements.push(
        md(
          projectListText({
            label: g.label,
            ...(g.statusLine ? { statusLine: g.statusLine } : {}),
            path: g.workspacePath,
          }),
        ),
      );
      elements.push(
        gridRow([
          {
            text: m.btnUnbindGroup,
            value: { cmd: "unbindgroup", chatId: g.chatId },
            style: "danger",
          },
        ]),
      );
    }
  }
  elements.push(
    HR,
    md(m.groupPickerTitle),
    ...listElements(m.groupNoNewGroupProjects, projects, (p) =>
      gridRow([{ text: m.btnMakeGroup, value: { cmd: "makegroup", sid: p.sid } }]),
    ),
  );
  return shell(m.groupOverviewTitle, elements);
}

/** The interactive /help menu card: a button for every command. When voice is
 *  installable (supported host, not yet installed) a one-tap install button is
 *  surfaced — the discoverable counterpart of Telegram's `/voice_install`. */
export function helpCard(
  group = false,
  voiceInstallable = false,
  promptTranslateInstallable = false,
): object {
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
  // Settings row: voice / translation / UI language.
  const langRow: ButtonSpec[] = [
    voiceInstallable
      ? { text: m.btnVoiceInstall, value: { cmd: "voiceinstall" }, style: "primary" }
      : { text: m.btnVoiceLang, value: { cmd: "voicelangmenu" } },
    promptTranslateInstallable
      ? { text: m.btnPromptTranslateInstall, value: { cmd: "translateinstall" }, style: "primary" }
      : { text: m.btnPromptTranslate, value: { cmd: "prompttranslate" } },
    { text: m.btnUiLang, value: { cmd: "uilangmenu" } },
  ];
  const prefsRows: ButtonSpec[][] = group
    ? [langRow]
    : [
        [
          { text: m.btnGroupMenu, value: { cmd: "groupmenu" } },
          { text: m.btnFreeGroup, value: { cmd: "freegroupmenu" } },
        ],
        langRow,
      ];
  return shell(m.helpTitle, [
    md(buildHelpBody("lark", "lark")),
    HR,
    md(m.helpRunning),
    ...HELP_SESSION_ROWS.flatMap((row) => gridRows(actionRow(row))),
    HR,
    md(m.helpProjects),
    ...gridRows([
      // Host-wide ops — p2p only (never leak all-session info / recovery into a group).
      ...(group
        ? []
        : [
            { text: m.btnDashboard, value: { cmd: "dashboard" } },
            { text: m.btnRecover, value: { cmd: "recover" } },
          ]),
      { text: m.btnPeek, value: { cmd: "peek" } },
      { text: m.btnHistory, value: { cmd: "history" } },
      { text: m.btnInputs, value: { cmd: "inputs" } },
      { text: m.btnQueue, value: { cmd: "queuestatus" } },
    ]),
    ...gridRows(projectRow),
    ...(group ? [] : [gridRow([{ text: m.btnStatusInstall, value: { cmd: "statusinstall" } }])]),
    ...prefsRows.flatMap((row) => gridRows(row)),
    // In a group, surface binding management at the bottom (restore / rebind /
    // unbind) so the group's home menu is self-sufficient — no need to hunt for a
    // separate card. Secondary emphasis; unbind is the only destructive one.
    ...(group
      ? [
          HR,
          gridRow([
            { text: m.btnRestoreGroup, value: { cmd: "restore" } },
            { text: m.btnRebindGroup, value: { cmd: "rebind" } },
            { text: m.btnUnbindGroup, value: { cmd: "unbind" }, style: "danger" },
          ]),
        ]
      : []),
  ]);
}

/** Autopilot panel card for supervisor-backed delegation. */
export function autopilotPanelCard(
  session: string,
  _group = false,
  delegateActive = false,
): object {
  const m = messages("lark");
  const rows: ButtonSpec[][] = [];
  rows.push([
    {
      text: delegateActive ? m.btnApCancelDelegate : m.btnApDelegate,
      value: { cmd: delegateActive ? "ap_cancel_delegate" : "ap_delegate", s: session },
      ...(delegateActive ? { style: "danger" } : {}),
    },
  ]);
  return shell(m.autopilotTitle, [
    md(m.autopilotDelegatePanelBody),
    HR,
    ...rows.flatMap((row) => gridRows(row)),
  ]);
}

export type { PromptsView } from "../../core/promptlib/view.js";

/** Prompt library browse card: tag filter row, one button per prompt, paging nav. */
export function promptsCard(
  items: Array<{ name: string; tags: string[]; description: string }>,
  tags: Array<{ tag: string; count: number }>,
  view: PromptsView,
): object {
  const m = messages("lark");
  const els: object[] = [];
  // Tag filter row
  const tagBtns: ButtonSpec[] = tags.slice(0, 6).map((t) => ({
    text: `${t.tag === view.tagFilter ? `${UI_ICONS.tone.ok} ` : `${UI_ICONS.feature.tag} `}${t.tag} (${t.count})`,
    value: { cmd: "pfilter", tagSid: sessionShortId(t.tag) },
  }));
  if (view.tagFilter)
    tagBtns.push({ text: m.promptsAll, value: { cmd: "ppage", page: 0, tagSid: "" } });
  if (tagBtns.length) els.push(...gridRows(tagBtns));
  // One row per prompt: name+tags+description as md, then a "view/copy" button
  for (const p of items) {
    els.push(
      md(
        `**${p.name}**${p.tags.length ? `  \`${p.tags.join(", ")}\`` : ""}${p.description ? ` — ${p.description}` : ""}`,
      ),
    );
    els.push(
      gridRow([{ text: m.promptsOpen, value: { cmd: "pget", sid: sessionShortId(p.name) } }]),
    );
  }
  // Paging nav
  const f = view.tagFilter ? sessionShortId(view.tagFilter) : "";
  const nav: ButtonSpec[] = [];
  if (view.page > 0)
    nav.push({ text: "◀", value: { cmd: "ppage", page: view.page - 1, tagSid: f } });
  if (view.page < view.totalPages - 1)
    nav.push({ text: "▶", value: { cmd: "ppage", page: view.page + 1, tagSid: f } });
  if (nav.length) els.push(gridRow(nav));
  return shell(m.promptsTitle(items.length), els);
}
