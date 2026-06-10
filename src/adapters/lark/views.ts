import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { formatSingleConversation, getRecentConversations } from "../../core/history.js";
import { messages, resolveUiLang } from "../../core/i18n/index.js";
import { projectLabel } from "../../core/project-label.js";
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
import { sessionShortId } from "../../shared/utils/hash.js";
import { langCard, projectListCard, recentListCard, viewCard, voiceLangCard } from "./cards.js";
import { sendCard, sendError, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

/** Send the voice recognition-language picker card (current language marked). */
export async function sendVoiceLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendCard(channel, chatId, voiceLangCard(resolveWhisperLanguage("lark")));
}

/** Send the UI-language picker card (current language marked). */
export async function sendLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendCard(channel, chatId, langCard(resolveUiLang("lark")));
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
    const buttons = await aliveProjectButtons(deps, "lark");
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
    const buttons = await recentProjectButtons(deps, "lark");
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
  const session = await deps.currentProject.get("lark");
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
  const session = await deps.currentProject.get("lark");
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
  const session = await deps.currentProject.get("lark");
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
      await deps.currentProject.set("lark", sessionName);
      setPathForSession(sessionName, resolvedPath);
      await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
      await sendText(channel, chatId, messages("lark").alreadySwitched);
      return;
    }
    await createProjectSession(deps, "lark", sessionName, resolvedPath);
    await sendText(channel, chatId, messages("lark").projectCreatedPath(resolvedPath));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/**
 * Switch to (or create) a recent project by its short id. Mirrors the create
 * branch of the Telegram `addRecentProjectBySid`. Shared by the recent-list
 * "创建" button.
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
      await deps.currentProject.set("lark", sessionName);
      await sendText(channel, chatId, messages("lark").switched);
      return;
    }
    if (!isCdAllowed(projectPath, deps.config.cdAllowedDirs)) {
      await sendText(channel, chatId, messages("lark").pathNotAllowedPath(projectPath));
      return;
    }
    await createProjectSession(deps, "lark", sessionName, projectPath);
    await sendText(channel, chatId, messages("lark").projectCreatedPath(projectPath));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}
