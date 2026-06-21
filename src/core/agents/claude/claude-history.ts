import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { sleep } from "../../../shared/utils/sleep.js";
import { iterJsonlObjects } from "../../read/jsonl.js";
import {
  type ConversationRound,
  formatTranscriptTime,
  latestReplyForSentText,
  type SessionEntry,
} from "../../read/transcript.js";

/** Default Claude config root when no per-session CLAUDE_CONFIG_DIR is detected. */
export const DEFAULT_CONFIG_ROOT = nodePath.join(homedir(), ".claude");

export function projectPathToHistoryDir(
  projectPath: string,
  configRoot: string = DEFAULT_CONFIG_ROOT,
): string {
  // Claude encodes the cwd by replacing EVERY non-alphanumeric character with "-"
  // (not just "/" and "_"). Verified against real on-disk dirs:
  //   /Users/.../entropy-nexus-social_media_posts -> -Users-...-social-media-posts
  //   /private/tmp/tcb3-claude.J75ggs             -> -private-tmp-tcb3-claude-J75ggs
  // Handling only "/" and "_" silently misses "." (and spaces), so a dotted
  // project path resolved to the WRONG dir and /history, session listing, and
  // usage all came back empty — live-verified. Match claude's actual rule.
  const normalized = projectPath.startsWith("/") ? projectPath : `/${projectPath}`;
  const dirName = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  return nodePath.join(configRoot, "projects", dirName);
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .filter((item) => item.type === "text")
      .map((item) => String(item.text ?? ""))
      .join("");
  }
  return "";
}

function parseUserInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Skip session continuation system messages
  if (trimmed.startsWith("This session is being continued from a previous conversation"))
    return null;
  if (trimmed.startsWith("Summary:")) return null;

  // Extract command names like <command-name>/clear</command-name>
  const cmdMatch = trimmed.match(/<command-name>\/?([\w-]+)<\/command-name>/);
  if (cmdMatch) {
    return `[/${cmdMatch[1]}]`;
  }

  // Extract command messages like <command-message>/simplify</command-message>
  const msgMatch = trimmed.match(/<command-message>(.+?)<\/command-message>/s);
  if (msgMatch) {
    const inner = (msgMatch[1] ?? "").trim();
    if (inner.startsWith("/")) {
      return `[${inner}]`;
    }
    return inner.slice(0, 200);
  }

  // Skip local-command-caveat wrapper
  if (trimmed.startsWith("<local-command-caveat>")) return null;

  return trimmed;
}

interface HistoryFile {
  name: string;
  path: string;
  mtime: number;
}

async function listHistoryFilesByMtime(historyDir: string): Promise<HistoryFile[]> {
  const entries = await fs.readdir(historyDir);
  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  const files = await Promise.all(
    jsonlFiles.map(async (name) => {
      const filePath = nodePath.join(historyDir, name);
      const stat = await fs.stat(filePath);
      return { name, path: filePath, mtime: stat.mtimeMs };
    }),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// Parse one jsonl transcript into user→assistant rounds, chronological (oldest
// first). This is the single source of truth shared by `/history` and the live
// reply lookup, so both apply identical pairing:
// - consecutive user messages merge, round time anchored to the latest one
// - only the final assistant text block of a turn is kept; the tool_result
//   messages that separate intermediate assistant turns carry no text and are
//   dropped, so appending would collapse the whole agentic trace into one blob
function parseConversationRounds(rawContent: string, fileName: string): ConversationRound[] {
  const messages: { role: "user" | "assistant"; text: string; time: string; timeMs: number }[] = [];

  for (const d of iterJsonlObjects<Record<string, unknown>>(rawContent)) {
    try {
      const type = d.type;
      if (type !== "user" && type !== "assistant") continue;
      if (d.isMeta) continue;

      const text = extractText((d.message as Record<string, unknown> | undefined)?.content);
      if (!text.trim()) continue;

      const rawTs = String((d.timestamp as string | undefined) ?? "");
      const time = formatTranscriptTime(rawTs);
      const timeMs = Date.parse(rawTs) || 0;

      const prev = messages[messages.length - 1];

      if (type === "user") {
        const parsed = parseUserInput(text);
        if (!parsed) continue;

        if (prev && prev.role === "user") {
          // Anchor the round to the latest user message. Otherwise a stale
          // prefix (e.g. a `/clear` from a previous day) keeps its old time
          // and the round looks far older than the real prompt.
          prev.time = time;
          prev.timeMs = timeMs;
          const prevIsCommand = prev.text.startsWith("[") && prev.text.endsWith("]");
          const currIsCommand = parsed.startsWith("[") && parsed.endsWith("]");

          if (prevIsCommand && !currIsCommand) {
            // Command followed by text: [command] + text
            prev.text = `${prev.text} ${parsed.slice(0, 150)}`;
          } else if (currIsCommand) {
            // New command replaces old one (or keep latest)
            prev.text = parsed;
          } else {
            prev.text += ` | ${parsed.slice(0, 150)}`;
          }
        } else {
          messages.push({ role: "user", text: parsed, time, timeMs });
        }
      } else {
        // assistant: keep only the final text block of the turn — the conclusion.
        if (prev && prev.role === "assistant") {
          prev.text = text;
          prev.time = time;
          prev.timeMs = timeMs;
        } else {
          messages.push({ role: "assistant", text, time, timeMs });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Pair user → assistant in chronological order.
  const rounds: ConversationRound[] = [];
  let i = 0;
  while (i < messages.length - 1) {
    // i < messages.length - 1 guarantees both messages[i] and messages[i+1] exist
    const cur = messages[i];
    const next = messages[i + 1];
    if (
      cur !== undefined &&
      next !== undefined &&
      cur.role === "user" &&
      next.role === "assistant"
    ) {
      rounds.push({
        user: cur.text,
        assistant: next.text,
        time: cur.time,
        timeMs: cur.timeMs,
        file: fileName.slice(0, 8),
      });
      i += 2;
    } else {
      i++;
    }
  }
  return rounds;
}

export async function getRecentConversations(
  projectPath: string,
  configRoot: string = DEFAULT_CONFIG_ROOT,
  transcriptPath?: string | null,
): Promise<ConversationRound[]> {
  // When the live session's exact transcript is known (the pid's open file, under
  // same-cwd Free-Projects contention), read just THAT file — don't mix in other
  // sessions sharing the dir.
  if (transcriptPath) {
    try {
      const raw = await fs.readFile(transcriptPath, "utf-8");
      return parseConversationRounds(raw, nodePath.basename(transcriptPath)).reverse();
    } catch {
      return [];
    }
  }
  const historyDir = projectPathToHistoryDir(projectPath, configRoot);

  let files: HistoryFile[];
  try {
    files = await listHistoryFilesByMtime(historyDir);
  } catch {
    return [];
  }

  // Read only the newest few transcripts. `files` is mtime-sorted newest-first and
  // callers want recent rounds (latest history, or the reply to a just-sent prompt),
  // so reading every .jsonl in the project — potentially hundreds of multi-MB files,
  // fully into memory on each call — is wasteful and unnecessary.
  const MAX_HISTORY_FILES = 10;
  const allRounds: ConversationRound[] = [];
  for (const file of files.slice(0, MAX_HISTORY_FILES)) {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(file.path, "utf-8");
    } catch {
      continue;
    }
    // Reverse to newest-first within the file; files are already newest-first.
    allRounds.push(...parseConversationRounds(rawContent, file.name).reverse());
  }

  return allRounds;
}

/** List saved Claude session IDs for a project, newest-first. */
export async function listClaudeSessions(
  projectPath: string,
  configRoot: string = DEFAULT_CONFIG_ROOT,
  limit = 5,
): Promise<SessionEntry[]> {
  const dir = projectPathToHistoryDir(projectPath, configRoot);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const sessions: SessionEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const sessionId = entry.name.slice(0, -6);
    if (!UUID_RE.test(sessionId)) continue;
    try {
      const stat = await fs.stat(nodePath.join(dir, entry.name));
      sessions.push({ sessionId, mtime: stat.mtime });
    } catch {
      // skip unreadable entries
    }
  }
  return sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

async function getLatestAssistantReplyInternal(
  projectPath: string,
  sentText: string,
  configRoot: string,
  transcriptPath?: string | null,
): Promise<string | null> {
  // Prefer the live session's exact transcript (the pid's open file) — under
  // same-cwd contention the newest-mtime file can belong to a DIFFERENT session.
  if (transcriptPath) {
    try {
      const raw = await fs.readFile(transcriptPath, "utf-8");
      return latestReplyForSentText(
        parseConversationRounds(raw, nodePath.basename(transcriptPath)),
        sentText,
      );
    } catch {
      return null;
    }
  }
  const historyDir = projectPathToHistoryDir(projectPath, configRoot);

  let files: HistoryFile[];
  try {
    files = await listHistoryFilesByMtime(historyDir);
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // INTENTIONAL: only the newest transcript is scanned, not the newest N.
  // Considered scanning more files (the active reply could, in theory, land in a
  // file that isn't files[0] — e.g. a concurrent session in the same project dir,
  // or a turn split across files mid-stream). Rejected because: (1) the trigger is
  // very rare — the active session's file gets the newest mtime the moment it
  // writes the reply, so it IS files[0] in the normal case; (2) when this lookup
  // returns null the executor degrades gracefully to the pane snapshot, so the
  // user still gets an answer; (3) the safe multi-file variant (exact-match
  // fallback over older files) has a stale-reply window for RE-SENT identical
  // prompts — before Claude echoes the new user line into the transcript, the
  // fallback can match an older identical prompt and return its stale reply
  // instead of waiting for the current one. The marginal coverage isn't worth
  // that regression. Do NOT "fix" this to scan more files without solving (3).
  // files.length >= 1 is guaranteed by the check above
  const latestFile = files[0];
  if (latestFile === undefined) return null;

  // The live reply lives in the most recently written transcript.
  let content: string;
  try {
    content = await fs.readFile(latestFile.path, "utf-8");
  } catch {
    return null;
  }

  // Reuse the shared parser so the live reply matches what /history shows:
  // the latest round, with only the final assistant text block.
  const rounds = parseConversationRounds(content, latestFile.name);
  return latestReplyForSentText(rounds, sentText);
}

export async function getLatestAssistantReply(
  projectPath: string,
  sentText: string,
  configRoot: string = DEFAULT_CONFIG_ROOT,
  transcriptPath?: string | null,
  maxRetries: number = 3,
  retryDelayMs: number = 500,
): Promise<string | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await getLatestAssistantReplyInternal(
      projectPath,
      sentText,
      configRoot,
      transcriptPath,
    );
    if (result?.trim()) {
      return result;
    }
    if (attempt < maxRetries) {
      await sleep(retryDelayMs);
    }
  }
  return null;
}
