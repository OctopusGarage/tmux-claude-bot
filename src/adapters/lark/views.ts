import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { startBrowse } from "../../core/dir-browser.js";
import { defaultProbes, renderDoctorReport, runDoctorChecks } from "../../core/doctor.js";
import { getBinding, isProjectGroup, listBindings } from "../../core/group-bindings.js";
import {
  formatSingleConversation,
  getRecentConversations,
  listClaudeSessions,
} from "../../core/history.js";
import { messages, resolveUiLang } from "../../core/i18n/index.js";
import { markSemantics } from "../../core/output.js";
import { projectLabel } from "../../core/project-label.js";
import { chatScope } from "../../core/project-manager.js";
import {
  aliveProjectButtons,
  type CreateProjectResult,
  createProjectFromPath,
  openRecentProjectBySid,
  recentProjectButtons,
} from "../../core/project-ops.js";
import { buildQueueStatusLines } from "../../core/queue-status.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import { type ForeignAction, runStatusInstall } from "../../core/status-install.js";
import { orphanLabel } from "../../core/takeover.js";
import { findAdoptableOrphans } from "../../core/takeover-service.js";
import { resolveWhisperLanguage } from "../../core/voice-support.js";
import { runWorkspaceCommand } from "../../core/workspace-command.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { sleep } from "../../shared/utils/sleep.js";
import {
  browseCard,
  groupBoundCard,
  groupPickerCard,
  langCard,
  orphanListCard,
  projectListCard,
  recentListCard,
  statusInstallCard,
  viewCard,
  voiceLangCard,
} from "./cards.js";
import { sendCard, sendError, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

/** Send the voice recognition-language picker card (current language marked).
 * A click re-sends the picker with the ✅ moved (regular interactive card). */
export async function sendVoiceLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendCard(channel, chatId, voiceLangCard(resolveWhisperLanguage("lark")));
}

/** Send the UI-language picker card (current language marked). */
export async function sendLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendCard(channel, chatId, langCard(resolveUiLang("lark")));
}

/** Run the install health checks and send the redacted report. */
export async function sendDoctor(channel: LarkChannel, chatId: string): Promise<void> {
  const report = await runDoctorChecks(defaultProbes());
  await sendText(channel, chatId, renderDoctorReport(report, { redacted: true }));
}

/**
 * Read-side renderers for the Lark adapter: fetch state (project lists, tmux
 * pane, history, queue) and render it into cards/text. Mirrors
 * telegram/views.ts. No mutation except `addProject`/`addRecentBySid`, which
 * create the project the way the Telegram `/add_project` handler does.
 */

/** The alive-projects list as a tappable switch/remove card. */
export async function sendAliveList(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  try {
    const buttons = await aliveProjectButtons(deps, chatScope("lark", chatId));
    await sendCard(channel, chatId, projectListCard(buttons, isProjectGroup(chatId)));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** The recent-projects list as a tappable switch/create card. */
export async function sendRecentList(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  try {
    const buttons = await recentProjectButtons(deps, chatScope("lark", chatId));
    await sendCard(channel, chatId, recentListCard(buttons, isProjectGroup(chatId)));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** List claude processes running outside tmux; each card row offers a take-over
 * button. Mirrors Telegram's `/adopt`. */
export async function sendOrphanList(channel: LarkChannel, chatId: string): Promise<void> {
  try {
    const orphans = await findAdoptableOrphans();
    if (orphans.length === 0) {
      await sendText(channel, chatId, messages("lark").adoptEmpty);
      return;
    }
    const rows = orphans.map((o) => ({ pid: o.pid, label: orphanLabel(o) }));
    await sendCard(channel, chatId, orphanListCard(rows));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Run the usage-reporting install and render the result card (with the
 * foreign-statusLine choice buttons when needed). Mirrors `/status_install`. */
export async function sendStatusInstall(
  channel: LarkChannel,
  chatId: string,
  action: ForeignAction = "scan",
): Promise<void> {
  try {
    const res = await runStatusInstall("lark", action);
    await sendCard(channel, chatId, statusInstallCard(res.lines.join("\n"), res.foreignPending));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Capture and send the current session's tmux pane in a view card. */
export async function sendPeek(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const session = await deps.currentProject.get(chatScope("lark", chatId));
  if (!session) {
    await sendText(channel, chatId, messages("lark").noCurrentProjectShort);
    return;
  }
  try {
    const snapshot = await deps.bridge.capturePane(session);
    const processed = markSemantics(deps.output.process(snapshot));
    const mid = await sendCard(
      channel,
      chatId,
      viewCard(
        messages("lark").paneTitle,
        processed || messages("lark").emptyPane,
        isProjectGroup(chatId),
      ),
    );
    if (mid) recordReplyTarget(mid, session);
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Send the Nth-most-recent conversation round for the current session (0 = latest). */
export async function sendHistory(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  index: number,
): Promise<void> {
  const session = await deps.currentProject.get(chatScope("lark", chatId));
  if (!session) {
    await sendText(channel, chatId, messages("lark").noCurrentProjectShort);
    return;
  }
  try {
    const projectPath = getPathBySession(session);
    if (!projectPath) {
      await sendText(channel, chatId, messages("lark").noPathMapping);
      return;
    }
    const configRoot = await deps.configResolver.resolveConfigRoot(session);
    const rounds = await getRecentConversations(projectPath, configRoot);
    if (rounds.length === 0) {
      await sendText(channel, chatId, messages("lark").noHistory);
      return;
    }
    if (index >= rounds.length) {
      await sendText(channel, chatId, messages("lark").onlyNRounds(rounds.length));
      return;
    }
    const round = rounds[index];
    if (round === undefined) return;
    const body = formatSingleConversation(round, index, rounds.length, "lark");
    const mid = await sendCard(
      channel,
      chatId,
      viewCard(messages("lark").historyTitle, body, isProjectGroup(chatId)),
    );
    if (mid) recordReplyTarget(mid, session);
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Build and send the message-queue status (global + per-session). No control
 * buttons — matches Telegram, where queue status is plain text. */
export async function sendQueueStatus(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  await sendText(channel, chatId, buildQueueStatusLines(deps, "lark").join("\n"));
}

/** Report the current project (or that none is set). */
export async function sendCurrentProject(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const session = await deps.currentProject.get(chatScope("lark", chatId));
  if (!session) {
    await sendText(channel, chatId, messages("lark").noCurrentProjectShort);
    return;
  }
  // Show the friendly label AND the full workspace directory underneath, so it's
  // clear which path the current project maps to (mirrors Telegram).
  const path = getPathBySession(session);
  const line = messages("lark").currentProjectIs(projectLabel(session, path ?? undefined));
  await sendText(channel, chatId, path ? `${line}\n${path}` : line);
}

/** Validate + create a project from a raw path (the typed `/add_project <path>`). */
export async function addProject(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  rawPath: string,
): Promise<void> {
  await replyCreateProject(
    channel,
    chatId,
    await createProjectFromPath(deps, chatScope("lark", chatId), rawPath),
  );
}

/** Map a `createProjectFromPath` outcome to a Lark reply — shared by the typed
 * `/add_project <path>` and the directory-browser "create here" button. */
export async function replyCreateProject(
  channel: LarkChannel,
  chatId: string,
  result: CreateProjectResult,
): Promise<void> {
  const m = messages("lark");
  switch (result.status) {
    case "invalid":
      if (result.error === "not-a-directory")
        await sendText(channel, chatId, m.notADir(result.resolvedPath));
      else if (result.error === "not-found")
        await sendText(channel, chatId, m.dirNotExist(result.resolvedPath));
      else await sendText(channel, chatId, m.pathNotAllowedPath(result.resolvedPath));
      return;
    case "switched":
      await sendText(channel, chatId, m.alreadySwitched);
      return;
    case "created":
      await sendText(channel, chatId, m.projectCreatedPath(result.projectPath));
      return;
    case "error":
      await sendError(channel, chatId, new Error(result.message));
      return;
  }
}

/** Open the directory browser as a managed card (so navigation updates it in
 * place). Mirrors the Telegram `/add_project` no-arg flow. */
export async function sendBrowse(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const view = startBrowse(chatScope("lark", chatId), deps.config.cdAllowedDirs);
  // Regular (not managed/CardKit) card: CardKit-entity button callbacks don't
  // fire in some Feishu app setups, whereas interactive-message buttons do. Each
  // navigation re-sends a fresh card rather than updating in place.
  await sendCard(channel, chatId, browseCard(view));
}

/**
 * Switch to (or create) a recent project by its short id. Mirrors the create
 * branch of the Telegram `addRecentProjectBySid`. Shared by the recent-list
 * "create" button.
 */
export async function addRecentBySid(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  sid: string,
): Promise<void> {
  const m = messages("lark");
  const r = await openRecentProjectBySid(deps, chatScope("lark", chatId), sid);
  switch (r.status) {
    case "not-found":
      await sendText(channel, chatId, m.shortIdNotFound(sid));
      return;
    case "switched":
      await sendText(channel, chatId, m.switched);
      return;
    case "not-allowed":
      await sendText(channel, chatId, m.pathNotAllowedPath(r.projectPath));
      return;
    case "created":
      await sendText(channel, chatId, m.projectCreatedPath(r.projectPath));
      return;
    case "error":
      await sendError(channel, chatId, new Error(r.message));
      return;
  }
}

/**
 * Context-aware "project groups" menu (the 🗂 button). In a bound group it shows
 * the binding + restore/rebind/unbind; otherwise it shows recent projects each
 * with a "new group" button — so creating/managing groups needs no typing.
 */
export async function sendGroupMenu(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const binding = getBinding(chatId);
  if (binding) {
    await sendCard(channel, chatId, groupBoundCard(binding.label));
    return;
  }
  // Hide "new group" for projects that already have a group (one workspace ↔ one
  // group); the handler also rejects it, but don't even offer the button.
  const grouped = new Set(listBindings().map(({ binding: b }) => sessionShortId(b.sessionName)));
  const buttons = (await recentProjectButtons(deps, chatScope("lark", chatId))).filter(
    (b) => !grouped.has(b.sid),
  );
  await sendCard(channel, chatId, groupPickerCard(buttons, "make"));
}

/** The recent-project picker in "bind" mode — used by the rebind button to pick a
 * new project for the current group. */
export async function sendGroupBindPicker(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const buttons = await recentProjectButtons(deps, chatScope("lark", chatId));
  await sendCard(channel, chatId, groupPickerCard(buttons, "bind"));
}

/**
 * Handle `/ws <subcommand> [name]` — workspace save/use/list/remove.
 * `arg` is everything after `/ws` (e.g. "save my-project").
 */
export async function handleWsCommand(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  arg: string | undefined,
): Promise<void> {
  // Lark has no tone layer, so the reply kind is ignored — just send the text.
  await runWorkspaceCommand(deps, "lark", chatId, arg, (_kind, text) =>
    sendText(channel, chatId, text),
  );
}

function formatAgo(date: Date): string {
  const diffMin = Math.round((Date.now() - date.getTime()) / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.round(diffH / 24)}d`;
}

/**
 * List saved Claude sessions for the current project. If `arg` is a session
 * ID prefix, exit the current Claude and resume that session.
 */
export async function sendSessionsList(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  arg: string | undefined,
): Promise<void> {
  const m = messages("lark");
  const session = await deps.currentProject.get(chatScope("lark", chatId));
  if (!session) {
    await sendText(channel, chatId, m.noCurrentProjectShort);
    return;
  }
  const projectPath = getPathBySession(session);
  if (!projectPath) {
    await sendText(channel, chatId, m.noPathMapping);
    return;
  }
  const configRoot = await deps.configResolver.resolveConfigRoot(session);

  if (arg) {
    const sessions = await listClaudeSessions(projectPath, configRoot);
    const match = sessions.find((s) => s.sessionId.startsWith(arg));
    if (!match) {
      await sendText(channel, chatId, m.noSessions);
      return;
    }
    await deps.bridge.sendExit(session);
    await sleep(2000);
    await deps.claude.startWithResume(session, match.sessionId);
    deps.configResolver.invalidate(session);
    await sendText(channel, chatId, m.resumeStarted(match.sessionId.slice(0, 8)));
    return;
  }

  const sessions = await listClaudeSessions(projectPath, configRoot);
  if (sessions.length === 0) {
    await sendText(channel, chatId, m.noSessions);
    return;
  }
  const lines = [
    m.sessionsTitle(sessions.length),
    ...sessions.map((s, i) => `${i + 1}. \`${s.sessionId.slice(0, 8)}\` (${formatAgo(s.mtime)})`),
    "",
    "用 `/sessions <id前缀>` 恢复",
  ];
  await sendText(channel, chatId, lines.join("\n"));
}
