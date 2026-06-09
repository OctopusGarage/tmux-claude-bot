import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { sleep } from "../utils/sleep.js";

export interface ConversationRound {
  user: string;
  assistant: string;
  time: string;
  file: string;
}

/** Default Claude config root when no per-session CLAUDE_CONFIG_DIR is detected. */
export const DEFAULT_CONFIG_ROOT = nodePath.join(homedir(), ".claude");

export function projectPathToHistoryDir(
  projectPath: string,
  configRoot: string = DEFAULT_CONFIG_ROOT,
): string {
  // Claude replaces both / and _ with - when creating history directory
  const normalized = projectPath.startsWith("/") ? projectPath : `/${projectPath}`;
  const dirName = normalized.replace(/\//g, "-").replace(/_/g, "-");
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
  const messages: { role: "user" | "assistant"; text: string; time: string }[] = [];

  for (const line of rawContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      const type = d.type;
      if (type !== "user" && type !== "assistant") continue;
      if (d.isMeta) continue;

      const text = extractText((d.message as Record<string, unknown> | undefined)?.content);
      if (!text.trim()) continue;

      const rawTime = String((d.timestamp as string | undefined) ?? "");
      const time = rawTime
        ? new Date(rawTime).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "";

      const prev = messages[messages.length - 1];

      if (type === "user") {
        const parsed = parseUserInput(text);
        if (!parsed) continue;

        if (prev && prev.role === "user") {
          // Anchor the round to the latest user message. Otherwise a stale
          // prefix (e.g. a `/clear` from a previous day) keeps its old time
          // and the round looks far older than the real prompt.
          prev.time = time;
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
          messages.push({ role: "user", text: parsed, time });
        }
      } else {
        // assistant: keep only the final text block of the turn — the conclusion.
        if (prev && prev.role === "assistant") {
          prev.text = text;
          prev.time = time;
        } else {
          messages.push({ role: "assistant", text, time });
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
): Promise<ConversationRound[]> {
  const historyDir = projectPathToHistoryDir(projectPath, configRoot);

  let files: HistoryFile[];
  try {
    files = await listHistoryFilesByMtime(historyDir);
  } catch {
    return [];
  }

  const allRounds: ConversationRound[] = [];
  for (const file of files) {
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

export function formatSingleConversation(
  round: ConversationRound,
  index: number,
  total: number,
): string {
  // Labels sit on their own lines so the user prompt and Claude's answer each
  // start at a line boundary — required for block markdown (headings, lists,
  // code fences) to render when the body is sent as MarkdownV2.
  return [
    `🗂 [${index + 1}/${total}] · ${round.time}`,
    "",
    "🧑‍💻 你",
    round.user,
    "",
    "🤖 Claude",
    "",
    round.assistant,
  ].join("\n");
}

async function getLatestAssistantReplyInternal(
  projectPath: string,
  sentText: string,
  configRoot: string,
): Promise<string | null> {
  const historyDir = projectPathToHistoryDir(projectPath, configRoot);

  let files: HistoryFile[];
  try {
    files = await listHistoryFilesByMtime(historyDir);
  } catch {
    return null;
  }
  if (files.length === 0) return null;

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
  const latest = rounds[rounds.length - 1];
  if (!latest?.assistant.trim()) return null;

  const normalizedSent = sentText.trim();
  const userText = latest.user.trim();

  if (userText === normalizedSent) {
    return latest.assistant;
  }

  // Fuzzy match only for substantial text to avoid matching short strings like "ok"
  // to unrelated messages (also covers a user prompt merged with a command prefix).
  const MIN_LEN_FOR_FUZZY = 10;
  if (userText.length >= MIN_LEN_FOR_FUZZY && normalizedSent.includes(userText)) {
    return latest.assistant;
  }
  if (normalizedSent.length >= MIN_LEN_FOR_FUZZY && userText.includes(normalizedSent)) {
    return latest.assistant;
  }

  return null;
}

export async function getLatestAssistantReply(
  projectPath: string,
  sentText: string,
  configRoot: string = DEFAULT_CONFIG_ROOT,
  maxRetries: number = 3,
  retryDelayMs: number = 500,
): Promise<string | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await getLatestAssistantReplyInternal(projectPath, sentText, configRoot);
    if (result?.trim()) {
      return result;
    }
    if (attempt < maxRetries) {
      await sleep(retryDelayMs);
    }
  }
  return null;
}
