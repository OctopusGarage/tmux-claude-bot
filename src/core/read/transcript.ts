import { messages } from "../i18n/index.js";
import type { Channel } from "../projects/project-manager.js";

/**
 * Agent-neutral conversation shapes + rendering shared by claude and codex. Each
 * agent parses its own on-disk transcript (claude: projects/<dir>/<uuid>.jsonl,
 * codex: rollout JSONL) into these rounds; everything downstream — the
 * "is this the reply to THIS message" rule and the /history rendering — is shared.
 */

export interface ConversationRound {
  user: string;
  assistant: string;
  time: string;
  /** Raw turn-start epoch ms (the user message's timestamp), unformatted — for
   * arithmetic like "how long has this turn run". Omitted when the source had none. */
  timeMs?: number;
  file: string;
}

export interface SessionEntry {
  sessionId: string;
  mtime: Date;
}

/**
 * Format a transcript timestamp (ISO string) as local `MM/DD HH:MM` for the
 * /history rows. Shared by BOTH agents so codex rows read identically to claude's
 * — codex previously stored the raw ISO UTC string, which rendered inconsistently
 * next to claude's formatted local time. Empty string for an empty/invalid input.
 */
export function formatTranscriptTime(rawIso: string): string {
  if (!rawIso) return "";
  const d = new Date(rawIso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * The assistant reply of the LATEST round, but only when that round's user text
 * matches `sentText` — so a not-yet-recorded turn returns null (caller retries /
 * falls back) rather than a stale earlier reply. Exact match, or a fuzzy
 * containment for substantial text (≥10 chars) to tolerate a prompt merged with
 * a command prefix. Both agents apply the same "is this the reply to THIS
 * message" rule.
 */
export function latestReplyForSentText(
  rounds: ConversationRound[],
  sentText: string,
): string | null {
  const latest = rounds[rounds.length - 1];
  if (!latest?.assistant.trim()) return null;

  const normalizedSent = sentText.trim();
  const userText = latest.user.trim();
  if (userText === normalizedSent) return latest.assistant;

  const MIN_LEN_FOR_FUZZY = 10;
  if (userText.length >= MIN_LEN_FOR_FUZZY && normalizedSent.includes(userText)) {
    return latest.assistant;
  }
  if (normalizedSent.length >= MIN_LEN_FOR_FUZZY && userText.includes(normalizedSent)) {
    return latest.assistant;
  }
  return null;
}

/** Render ONE conversation round for /history. Agent-neutral (the 🤖 label and
 * round content make the agent obvious), shared by both adapters. */
export function formatSingleConversation(
  round: ConversationRound,
  index: number,
  total: number,
  channel: Channel = "telegram",
): string {
  // Labels sit on their own lines so the user prompt and the agent's answer each
  // start at a line boundary — required for block markdown (headings, lists,
  // code fences) to render when the body is sent as MarkdownV2.
  return [
    `🗂 [${index + 1}/${total}] · ${round.time}`,
    "",
    messages(channel).historyYou,
    round.user,
    "",
    "🤖",
    "",
    round.assistant,
  ].join("\n");
}
