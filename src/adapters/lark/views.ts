import * as fs from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { formatSingleConversation, getRecentConversations } from "../../core/history.js";
import { projectLabel } from "../../core/project-label.js";
import { aliveProjectButtons, recentProjectButtons } from "../../core/project-ops.js";
import { appendRecentProject, readRecentProjectLines } from "../../core/recentProjects.js";
import {
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "../../core/sessionPathMap.js";
import { resolveWhisperLanguage } from "../../core/voice-support.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { sleep } from "../../shared/utils/sleep.js";
import { truncate } from "../../shared/utils/string.js";
import { projectListCard, recentListCard, viewCard, voiceLangCard } from "./cards.js";
import { sendCard, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

/** Send the voice recognition-language picker card (current language marked). */
export async function sendVoiceLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendCard(channel, chatId, voiceLangCard(resolveWhisperLanguage("lark")));
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
    await sendText(channel, chatId, `错误：${normalizeError(err).message}`);
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
    await sendText(channel, chatId, `错误：${normalizeError(err).message}`);
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
    await sendText(channel, chatId, "无当前项目");
    return;
  }
  try {
    const snapshot = await deps.bridge.capturePane(session);
    const processed = deps.output.process(snapshot);
    const mid = await sendCard(channel, chatId, viewCard("👁 tmux 画面", processed || "（空）"));
    if (mid) recordReplyTarget(mid, session);
  } catch (err) {
    await sendText(channel, chatId, `错误：${normalizeError(err).message}`);
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
    await sendText(channel, chatId, "无当前项目");
    return;
  }
  try {
    const projectPath = getPathBySession(session);
    if (!projectPath) {
      await sendText(channel, chatId, "缺少项目路径映射 · 先用 /add_project 建立");
      return;
    }
    const configRoot = await deps.configResolver.resolveConfigRoot(session);
    const rounds = await getRecentConversations(projectPath, configRoot);
    if (rounds.length === 0) {
      await sendText(channel, chatId, "没有找到对话历史");
      return;
    }
    if (index >= rounds.length) {
      await sendText(channel, chatId, `只有 ${rounds.length} 条对话记录`);
      return;
    }
    const round = rounds[index];
    if (round === undefined) return;
    const body = formatSingleConversation(round, index, rounds.length);
    const mid = await sendCard(channel, chatId, viewCard("📜 历史记录", body));
    if (mid) recordReplyTarget(mid, session);
  } catch (err) {
    await sendText(channel, chatId, `错误：${normalizeError(err).message}`);
  }
}

/** Build and send the message-queue status (global + per-session). No control
 * buttons — matches Telegram, where queue status is plain text. */
export async function sendQueueStatus(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const lines: string[] = [];

  const globalQueue = deps.queue.getGlobalQueue();
  const globalProcessing = deps.queue.isGlobalProcessing();
  const globalCurrent = deps.queue.getCurrentGlobalMessage();
  lines.push(`━━ 🌐 全局队列 ━━`);
  lines.push(`排队中： ${globalQueue.length} | 处理中： ${globalProcessing ? "🟢" : "🔴"}`);
  if (globalCurrent) {
    lines.push(`  ▶ ${truncate(globalCurrent.text, 40)}`);
  }
  if (globalQueue.length > 0) {
    globalQueue.forEach((msg, i) => {
      lines.push(`  ${i + 1}. ${truncate(msg.text, 40)}`);
    });
  }

  const sessionNames = deps.queue.getSessionNames();
  if (sessionNames.length === 0) {
    lines.push(`\n━━ 会话队列 ━━`);
    lines.push(`没有活跃的会话队列`);
  } else {
    for (const sessionName of sessionNames.sort()) {
      const queueItems = deps.queue.getSessionQueue(sessionName);
      const isProcessing = deps.queue.isSessionProcessing(sessionName);
      const currentMsg = deps.queue.getCurrentSessionMessage(sessionName);
      const lastAt = deps.queue.getLastProcessedAt(sessionName);
      const name = projectLabel(sessionName, getPathBySession(sessionName) ?? undefined);
      lines.push(`\n━━ 📂 ${name} ━━`);
      lines.push(`排队中： ${queueItems.length} | 处理中： ${isProcessing ? "🟢" : "🔴"}`);
      if (currentMsg) {
        lines.push(`  ▶ ${truncate(currentMsg.text, 40)}`);
      }
      if (queueItems.length > 0) {
        queueItems.forEach((msg, i) => {
          lines.push(`  ${i + 1}. ${truncate(msg.text, 40)}`);
        });
      }
      if (lastAt) {
        const secondsAgo = Math.floor((Date.now() - lastAt) / 1000);
        lines.push(`  上次完成： ${secondsAgo}s 前`);
      }
    }
  }

  await sendText(channel, chatId, lines.join("\n"));
}

/** Report the current project (or that none is set). */
export async function sendCurrentProject(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const session = await deps.currentProject.get("lark");
  if (!session) {
    await sendText(channel, chatId, "无当前项目");
    return;
  }
  await sendText(
    channel,
    chatId,
    `当前项目：${projectLabel(session, getPathBySession(session) ?? undefined)}`,
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
  const resolvedPath = nodePath.resolve(rawPath.replaceAll("~", homedir()));

  try {
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) {
      await sendText(channel, chatId, `${resolvedPath} 不是目录`);
      return;
    }
  } catch {
    await sendText(channel, chatId, `目录不存在：${resolvedPath}`);
    return;
  }

  if (!isCdAllowed(resolvedPath, deps.config.cdAllowedDirs)) {
    await sendText(channel, chatId, `路径不在允许范围内：${resolvedPath}`);
    return;
  }

  const sessionName = sessionNameFromPath(resolvedPath, deps.config.projectSessionPrefix);
  try {
    if (await deps.bridge.hasSession(sessionName)) {
      await deps.currentProject.set("lark", sessionName);
      setPathForSession(sessionName, resolvedPath);
      await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
      await sendText(channel, chatId, "已存在 · 已切换");
      return;
    }
    await deps.bridge.createSession(sessionName);
    await deps.currentProject.set("lark", sessionName);
    await sleep(deps.config.sessionWarmupMs);
    await deps.bridge.sendKeys(`cd "${resolvedPath}"`);
    await sleep(deps.config.sessionWarmupMs);
    setPathForSession(sessionName, resolvedPath);
    await appendRecentProject(resolvedPath, deps.config.projectSessionPrefix);
    await sendText(channel, chatId, `项目已创建：${resolvedPath}`);
  } catch (err) {
    await sendText(channel, chatId, `错误：${normalizeError(err).message}`);
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
    await sendText(channel, chatId, `未找到短 id：${sid}`);
    return;
  }
  const sessionName = sessionNameFromPath(projectPath, prefix);
  try {
    if (await deps.bridge.hasSession(sessionName)) {
      await deps.currentProject.set("lark", sessionName);
      await sendText(channel, chatId, "已切换");
      return;
    }
    if (!isCdAllowed(projectPath, deps.config.cdAllowedDirs)) {
      await sendText(channel, chatId, `路径不在允许范围内：${projectPath}`);
      return;
    }
    await deps.bridge.createSession(sessionName);
    await deps.currentProject.set("lark", sessionName);
    setPathForSession(sessionName, projectPath);
    await sleep(deps.config.sessionWarmupMs);
    await deps.bridge.sendKeys(`cd "${projectPath}"`);
    await sleep(deps.config.sessionWarmupMs);
    await appendRecentProject(projectPath, prefix);
    await sendText(channel, chatId, `项目已创建：${projectPath}`);
  } catch (err) {
    await sendText(channel, chatId, `错误：${normalizeError(err).message}`);
  }
}
