import * as fs from "node:fs/promises";
import { sleep } from "../../../shared/utils/sleep.js";
import { iterJsonlObjects } from "../../read/jsonl.js";
import {
  type ConversationRound,
  formatTranscriptTime,
  latestReplyForSentText,
  type SessionEntry,
} from "../../read/transcript.js";
import { collectRolloutFiles, findRolloutForProject, rolloutMeta } from "./codex-rollout.js";

/**
 * Parse a codex session rollout (JSONL) into chronological user→assistant rounds,
 * the same shape claude's transcript parser produces, so the shared
 * {@link latestReplyForSentText} and /history rendering work for both agents.
 *
 * Codex records conversation turns as `response_item` events with
 * `payload.type === "message"`: a user turn is `role: "user"` with
 * `input_text` content; the assistant turn is `role: "assistant"` with
 * `output_text` content (there may be several assistant message items per turn —
 * reasoning / tool calls are separate item types and ignored here). A new user
 * message starts a new round; subsequent assistant text accumulates into it.
 */
export function parseCodexRounds(jsonlText: string): ConversationRound[] {
  const rounds: ConversationRound[] = [];
  let current: ConversationRound | null = null;

  for (const obj of iterJsonlObjects<{
    timestamp?: string;
    payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> };
  }>(jsonlText)) {
    const p = obj.payload;
    if (p?.type !== "message") continue;

    const text = (p.content ?? [])
      .filter((c) => c.type === "input_text" || c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();

    if (p.role === "user") {
      // A user message — even one with empty text (filtered/no input_text) —
      // closes the previous round so a later assistant message can't bleed back
      // into it. Only open (and push) a new round when there is actual text.
      current = null;
      if (!text) continue;
      current = {
        user: text,
        assistant: "",
        time: formatTranscriptTime(obj.timestamp ?? ""),
        timeMs: Date.parse(obj.timestamp ?? "") || 0,
        file: "codex",
      };
      rounds.push(current);
    } else if (p.role === "assistant") {
      if (!text) continue;
      // Assistant text only attaches to a user turn opened immediately before it.
      // With no open round (file starts assistant/system, or the preceding user
      // turn was filtered), open an anonymous round so the reply isn't dropped or
      // merged into a stale prior round.
      if (!current) {
        current = {
          user: "",
          assistant: "",
          time: formatTranscriptTime(obj.timestamp ?? ""),
          timeMs: Date.parse(obj.timestamp ?? "") || 0,
          file: "codex",
        };
        rounds.push(current);
      }
      current.assistant += current.assistant ? `\n${text}` : text;
    }
  }
  return rounds;
}

/**
 * Codex counterpart of {@link getRecentConversations}: parse the newest rollout
 * matching `projectPath` into user→assistant rounds and return the last `limit`,
 * newest-first (matching how `getRecentConversations` orders its rounds). Returns
 * [] when there is no matching rollout or it can't be read.
 */
export async function getRecentCodexConversations(
  codexHome: string,
  projectPath: string,
  limit = 10,
  rolloutPath?: string | null,
): Promise<ConversationRound[]> {
  // Prefer the live codex's open rollout (exact under same-cwd contention); fall
  // back to the newest cwd-matched rollout when no live session is given.
  const path = rolloutPath ?? (await findRolloutForProject(codexHome, projectPath))?.path ?? null;
  if (!path) return [];
  let content: string;
  try {
    content = await fs.readFile(path, "utf-8");
  } catch {
    return [];
  }
  // parseCodexRounds yields chronological (oldest-first) rounds; the claude
  // path reverses each file to newest-first, so reverse here too, then keep the
  // most recent `limit`.
  return parseCodexRounds(content).reverse().slice(0, limit);
}

/**
 * Codex counterpart of {@link listClaudeSessions}: list resumable codex sessions
 * for `projectPath`, newest-first. Walks `<codexHome>/sessions/**` for rollout
 * JSONLs whose first line is a `session_meta` with a matching `payload.cwd`, and
 * collects `{ sessionId: payload.id, mtime }`. Best-effort; swallows fs errors.
 */
export async function listCodexSessions(
  codexHome: string,
  projectPath: string,
  limit = 20,
): Promise<SessionEntry[]> {
  // Read first-lines newest-first and STOP once `limit` cwd-matches are found, so
  // files older than the limit-th match are never opened (mirrors
  // findRolloutForProject). Copy before sorting — collectRolloutFiles is memoized,
  // so the returned array is shared across concurrent callers.
  const files = [...(await collectRolloutFiles(codexHome))].sort((a, b) => b.mtime - a.mtime);
  const sessions: SessionEntry[] = [];
  for (const f of files) {
    const meta = await rolloutMeta(f.path); // bounded first-line read of session_meta
    if (meta?.type !== "session_meta" || meta.cwd !== projectPath || !meta.id) continue;
    sessions.push({ sessionId: meta.id, mtime: new Date(f.mtime) });
    if (sessions.length >= limit) break;
  }
  return sessions;
}

/**
 * Codex counterpart of {@link getLatestAssistantReply}: the assistant reply to
 * `sentText` from the session's rollout, with the same retry budget (the rollout
 * is appended as codex streams, so the final message can lag the pane going idle).
 * Returns null when no matching reply is found — the executor then falls back to
 * the pane snapshot.
 *
 * The rollout PATH is resolved once: it doesn't change across the short retry
 * window (codex creates the file at session start, then only appends), so the
 * loop just re-reads the growing file rather than re-walking sessions/** each try.
 */
export async function getLatestCodexReply(
  configRoot: string,
  projectPath: string,
  sentText: string,
  rolloutPath?: string | null,
  maxRetries = 3,
  retryDelayMs = 500,
): Promise<string | null> {
  const path = rolloutPath ?? (await findRolloutForProject(configRoot, projectPath))?.path ?? null;
  if (!path) return null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let content = "";
    try {
      content = await fs.readFile(path, "utf-8");
    } catch {
      // file vanished/locked between tries — treat as no reply yet, keep retrying
    }
    const reply = latestReplyForSentText(parseCodexRounds(content), sentText);
    if (reply?.trim()) return reply;
    if (attempt < maxRetries) await sleep(retryDelayMs);
  }
  return null;
}
