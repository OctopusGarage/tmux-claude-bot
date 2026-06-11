import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { defaultProbes, renderDoctorReport, runDoctorChecks } from "../../core/doctor.js";
import {
  formatSingleConversation,
  getRecentConversations,
  listClaudeSessions,
} from "../../core/history.js";
import { messages, resolveUiLang } from "../../core/i18n/index.js";
import { projectLabel } from "../../core/project-label.js";
import { chatScope } from "../../core/project-manager.js";
import {
  aliveProjectButtons,
  createProjectSession,
  recentProjectButtons,
  resolveProjectPath,
} from "../../core/project-ops.js";
import { buildQueueStatusLines } from "../../core/queue-status.js";
import { appendRecentProject, readRecentProjectLines } from "../../core/recentProjects.js";
import {
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "../../core/sessionPathMap.js";
import { resolveWhisperLanguage } from "../../core/voice-support.js";
import {
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  saveWorkspace,
  WORKSPACE_NAME_RE,
} from "../../core/workspaces.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { sleep } from "../../shared/utils/sleep.js";
import { langCard, projectListCard, recentListCard, viewCard, voiceLangCard } from "./cards.js";
import { sendManagedCard } from "./managed-card.js";
import { sendCard, sendError, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

/** Send the voice recognition-language picker card (current language marked).
 * Managed, so a click moves the ✅ on the card itself instead of re-sending. */
export async function sendVoiceLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendManagedCard(channel, chatId, voiceLangCard(resolveWhisperLanguage("lark")));
}

/** Send the UI-language picker card (current language marked). Managed, like
 * the voice picker. */
export async function sendLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendManagedCard(channel, chatId, langCard(resolveUiLang("lark")));
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
    await sendCard(channel, chatId, projectListCard(buttons));
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
    await sendCard(channel, chatId, recentListCard(buttons));
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
    const processed = deps.output.process(snapshot);
    const mid = await sendCard(
      channel,
      chatId,
      viewCard(messages("lark").paneTitle, processed || messages("lark").emptyPane),
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
    const mid = await sendCard(channel, chatId, viewCard(messages("lark").historyTitle, body));
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
  await sendText(
    channel,
    chatId,
    messages("lark").currentProjectIs(
      projectLabel(session, getPathBySession(session) ?? undefined),
    ),
  );
}

/**
 * Validate + create a project from a raw path (mirrors the Telegram
 * `/add_project` handler): expand `~`, resolve abs path, check the directory
 * exists and is allowed, then switch to or create the tmux session.
 */
export async function addProject(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  rawPath: string,
): Promise<void> {
  const { resolvedPath, error } = await resolveProjectPath(rawPath, deps.config.cdAllowedDirs);
  const m = messages("lark");
  if (error === "not-a-directory") {
    await sendText(channel, chatId, m.notADir(resolvedPath));
    return;
  }
  if (error === "not-found") {
    await sendText(channel, chatId, m.dirNotExist(resolvedPath));
    return;
  }
  if (error === "not-allowed") {
    await sendText(channel, chatId, m.pathNotAllowedPath(resolvedPath));
    return;
  }

  const sessionName = sessionNameFromPath(resolvedPath, deps.config.projectSessionPrefix);
  try {
    if (await deps.bridge.hasSession(sessionName)) {
      await deps.currentProject.set(chatScope("lark", chatId), sessionName);
      setPathForSession(sessionName, resolvedPath);
      await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
      await sendText(channel, chatId, messages("lark").alreadySwitched);
      return;
    }
    await createProjectSession(deps, chatScope("lark", chatId), sessionName, resolvedPath);
    await sendText(channel, chatId, messages("lark").projectCreatedPath(resolvedPath));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
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
  const prefix = deps.config.projectSessionPrefix;
  const lines = await readRecentProjectLines();
  const projectPath = lines.find((p) => sessionShortId(sessionNameFromPath(p, prefix)) === sid);
  if (!projectPath) {
    await sendText(channel, chatId, messages("lark").shortIdNotFound(sid));
    return;
  }
  const sessionName = sessionNameFromPath(projectPath, prefix);
  try {
    if (await deps.bridge.hasSession(sessionName)) {
      await deps.currentProject.set(chatScope("lark", chatId), sessionName);
      await sendText(channel, chatId, messages("lark").switched);
      return;
    }
    if (!isCdAllowed(projectPath, deps.config.cdAllowedDirs)) {
      await sendText(channel, chatId, messages("lark").pathNotAllowedPath(projectPath));
      return;
    }
    await createProjectSession(deps, chatScope("lark", chatId), sessionName, projectPath);
    await sendText(channel, chatId, messages("lark").projectCreatedPath(projectPath));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
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
  const m = messages("lark");
  const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  const name = parts[1];

  if (sub === "list") {
    const all = listWorkspaces();
    if (all.length === 0) {
      await sendText(channel, chatId, m.wsListEmpty);
      return;
    }
    const lines = [m.wsListTitle, ...all.map((w) => m.wsListItem(w.name, w.session))];
    await sendText(channel, chatId, lines.join("\n"));
    return;
  }

  if (sub === "save") {
    if (!name || !WORKSPACE_NAME_RE.test(name)) {
      await sendText(channel, chatId, name ? m.wsInvalidName : m.wsUsage);
      return;
    }
    const session = await deps.currentProject.get(chatScope("lark", chatId));
    if (!session) {
      await sendText(channel, chatId, m.wsNoCurrentProject);
      return;
    }
    saveWorkspace(name, session);
    await sendText(channel, chatId, m.wsSaved(name, session));
    return;
  }

  if (sub === "use") {
    if (!name || !WORKSPACE_NAME_RE.test(name)) {
      await sendText(channel, chatId, name ? m.wsInvalidName : m.wsUsage);
      return;
    }
    const session = getWorkspace(name);
    if (!session) {
      await sendText(channel, chatId, m.wsNotFound(name));
      return;
    }
    if (!(await deps.bridge.hasSession(session))) {
      await sendText(channel, chatId, m.wsSessionGone(name));
      return;
    }
    await deps.currentProject.set(chatScope("lark", chatId), session);
    await sendText(channel, chatId, m.wsUsed(name));
    return;
  }

  if (sub === "remove") {
    if (!name || !WORKSPACE_NAME_RE.test(name)) {
      await sendText(channel, chatId, name ? m.wsInvalidName : m.wsUsage);
      return;
    }
    if (!removeWorkspace(name)) {
      await sendText(channel, chatId, m.wsNotFound(name));
      return;
    }
    await sendText(channel, chatId, m.wsRemoved(name));
    return;
  }

  await sendText(channel, chatId, m.wsUsage);
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
