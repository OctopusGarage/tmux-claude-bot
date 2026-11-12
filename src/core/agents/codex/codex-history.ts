import * as fs from "node:fs/promises";
import { sleep } from "../../../shared/utils/sleep.js";
import { iterJsonlObjects } from "../../read/jsonl.js";
import {
  type ConversationRound,
  formatTranscriptTime,
  latestReplyForSentText,
  type SessionEntry,
} from "../../read/transcript.js";
import type { AgentTurnCompletion, AgentTurnCursor } from "../types.js";
import { collectRolloutFiles, findRolloutForProject, rolloutMeta } from "./codex-rollout.js";

/** Managed completion reads only bounded new bytes from the exact live rollout. */
export async function readCodexTurnCompletion(
  rolloutPath: string,
  sessionId: string,
  sentText: string,
  sentAfter: number,
  cursor?: AgentTurnCursor,
): Promise<AgentTurnCompletion> {
  const unavailable: AgentTurnCompletion = { status: "unavailable", output: "" };
  if (cursor && (cursor.path !== rolloutPath || cursor.sessionId !== sessionId)) return unavailable;
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    file = await fs.open(rolloutPath, "r");
    const stat = await file.stat();
    const fileIdentity = `${stat.dev}:${stat.ino}`;
    if (cursor && (cursor.fileIdentity !== fileIdentity || stat.size < cursor.offset))
      return unavailable;
    const header = Buffer.alloc(64 * 1024);
    const head = await file.read(header, 0, header.length, 0);
    const meta = JSON.parse(header.toString("utf8", 0, head.bytesRead).split("\n")[0] ?? "") as {
      type?: string;
      payload?: { id?: string };
    };
    if (meta.type !== "session_meta" || meta.payload?.id !== sessionId) return unavailable;
    const next: AgentTurnCursor = {
      path: rolloutPath,
      sessionId,
      fileIdentity,
      ...(cursor?.agentPid !== undefined ? { agentPid: cursor.agentPid } : {}),
      offset: cursor?.offset ?? 0,
      ...(cursor?.turn ? { turn: { ...cursor.turn } } : {}),
    };
    const limit = 1024 * 1024;
    if (sentAfter === Number.POSITIVE_INFINITY) {
      const tailStart = Math.max(0, stat.size - limit);
      const tail = Buffer.alloc(stat.size - tailStart);
      await file.read(tail, 0, tail.length, tailStart);
      const content = tail.toString("utf8");
      if (!content.endsWith("\n")) return unavailable;
      let root: string | undefined;
      let terminal = false;
      for (const entry of parseTurnRecords<{
        type?: string;
        payload?: { type?: string; turn_id?: string; root_turn_id?: string };
      }>(tailStart ? content.slice(content.indexOf("\n") + 1) : content)) {
        const p = entry.payload;
        if (entry.type !== "event_msg" || !p) continue;
        if (p.type === "task_started" && p.turn_id && p.turn_id === p.root_turn_id) {
          root = p.turn_id;
          terminal = false;
        } else if (
          root &&
          p.turn_id === root &&
          p.root_turn_id === root &&
          (p.type === "task_complete" || p.type === "turn_aborted")
        )
          terminal = true;
      }
      if (tailStart && !root) return unavailable;
      return {
        status: root && !terminal ? "running" : "pending",
        output: "",
        cursor: { ...next, offset: stat.size, atEnd: true },
      };
    }
    const bytes = Math.min(limit, Math.max(0, stat.size - next.offset));
    if (bytes > 0) {
      const buffer = Buffer.alloc(bytes);
      const read = await file.read(buffer, 0, bytes, next.offset);
      const newline = buffer.lastIndexOf(10, read.bytesRead - 1);
      if (newline < 0 && read.bytesRead === limit) return unavailable;
      if (newline >= 0) {
        const content = buffer.toString("utf8", 0, newline + 1);
        next.offset += newline + 1;
        for (const entry of parseTurnRecords<{
          type?: string;
          timestamp?: string;
          payload?: {
            type?: string;
            role?: string;
            turn_id?: string;
            root_turn_id?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        }>(content)) {
          const payload = entry.payload;
          const timestamp = Date.parse(entry.timestamp ?? "");
          if (!payload || !Number.isFinite(timestamp) || timestamp < sentAfter) continue;
          if (entry.type === "event_msg" && payload.type === "task_started") {
            if (typeof payload.turn_id !== "string" || typeof payload.root_turn_id !== "string")
              delete next.turn;
            else if (payload.turn_id === payload.root_turn_id)
              next.turn = {
                id: payload.turn_id,
                rootId: payload.root_turn_id,
                matched: false,
                status: "pending",
                output: "",
              };
          } else if (next.turn && entry.type === "response_item" && payload.type === "message") {
            const text = (Array.isArray(payload.content) ? payload.content : [])
              .filter((item) => item.type === "input_text" || item.type === "output_text")
              .map((item) => item.text ?? "")
              .join("")
              .trim();
            if (payload.role === "user") {
              if (next.turn.status === "completed" || next.turn.status === "aborted") {
                delete next.turn;
                continue;
              }
              // Context/steering USER records do not replace an already bound active root.
              if (!next.turn.matched) {
                next.turn.matched = text === sentText.trim();
                next.turn.status = next.turn.matched ? "running" : "pending";
                next.turn.output = "";
              }
            } else if (
              payload.role === "assistant" &&
              next.turn.matched &&
              next.turn.status === "running" &&
              text
            ) {
              next.turn.output = `${next.turn.output}${next.turn.output ? "\n" : ""}${text}`.slice(
                -limit,
              );
            }
          } else if (
            next.turn?.matched &&
            entry.type === "event_msg" &&
            payload.turn_id === next.turn.id &&
            payload.root_turn_id === next.turn.rootId
          ) {
            if (payload.type === "task_complete") next.turn.status = "completed";
            if (payload.type === "turn_aborted") next.turn.status = "aborted";
          }
        }
      }
    }
    next.atEnd = next.offset === stat.size;
    const status = next.turn?.status ?? "pending";
    // Do not accept a terminal event while newer unread records may supersede it.
    return {
      status: !next.atEnd && (status === "completed" || status === "aborted") ? "running" : status,
      output: next.turn?.output ?? "",
      cursor: next,
    };
  } catch {
    return unavailable;
  } finally {
    await file?.close().catch(() => {});
  }
}

function parseTurnRecords<T>(content: string): T[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

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
