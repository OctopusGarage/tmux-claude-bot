import { truncate } from "../shared/utils/string.js";
import type { HandlerDeps } from "./deps.js";
import { messages } from "./i18n/index.js";
import { projectLabel } from "./project-label.js";
import type { Channel } from "./project-manager.js";
import { getPathBySession } from "./sessionPathMap.js";

/**
 * Build the message-queue status report (global queue + per-session queues) as
 * text lines, in the channel's language. Protocol-agnostic: both adapters render
 * the exact same body and only differ in how they send it (Telegram reply vs
 * Lark text), so the rendering lives here instead of being copied in each views.ts.
 */
export function buildQueueStatusLines(deps: HandlerDeps, channel: Channel): string[] {
  const m = messages(channel);
  const lines: string[] = [];

  const globalQueue = deps.queue.getGlobalQueue();
  lines.push(m.queueGlobalHeader);
  lines.push(m.queueCounts(globalQueue.length, deps.queue.isGlobalProcessing()));
  const globalCurrent = deps.queue.getCurrentGlobalMessage();
  if (globalCurrent) lines.push(`  ▶ ${truncate(globalCurrent.text, 40)}`);
  globalQueue.forEach((msg, i) => {
    lines.push(`  ${i + 1}. ${truncate(msg.text, 40)}`);
  });

  const sessionNames = deps.queue.getSessionNames();
  if (sessionNames.length === 0) {
    lines.push(`\n${m.queueSessionHeader}`);
    lines.push(m.queueNoSessions);
    return lines;
  }
  for (const sessionName of sessionNames.sort()) {
    const queueItems = deps.queue.getSessionQueue(sessionName);
    const name = projectLabel(sessionName, getPathBySession(sessionName) ?? undefined);
    lines.push(`\n━━ 📂 ${name} ━━`);
    lines.push(m.queueCounts(queueItems.length, deps.queue.isSessionProcessing(sessionName)));
    const currentMsg = deps.queue.getCurrentSessionMessage(sessionName);
    if (currentMsg) lines.push(`  ▶ ${truncate(currentMsg.text, 40)}`);
    queueItems.forEach((msg, i) => {
      lines.push(`  ${i + 1}. ${truncate(msg.text, 40)}`);
    });
    const lastAt = deps.queue.getLastProcessedAt(sessionName);
    if (lastAt) {
      lines.push(`  ${m.queueLastDone(Math.floor((Date.now() - lastAt) / 1000))}`);
    }
  }
  return lines;
}
