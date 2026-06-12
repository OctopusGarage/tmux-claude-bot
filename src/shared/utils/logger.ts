import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

// Override with TCB_LOG_DIR for test isolation.
const LOG_DIR = process.env.TCB_LOG_DIR ?? nodePath.join(os.homedir(), ".tmux-claude-bot", "logs");
const MAX_ARCHIVE_DAYS = 30;

export type LogCtx = {
  session?: string;
  chatId?: string | number;
  channel?: "telegram" | "lark";
};

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVELS: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function parseLevel(env: string | undefined): LogLevel {
  switch (env?.toUpperCase()) {
    case "DEBUG":
      return "DEBUG";
    case "WARN":
      return "WARN";
    case "ERROR":
      return "ERROR";
    default:
      return "INFO";
  }
}

const MIN_LEVEL = parseLevel(process.env.LOG_LEVEL);

function getDateStr(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function getLogFile(dateStr: string): string {
  return nodePath.join(LOG_DIR, `tcb-${dateStr}.jsonl`);
}

let lastCleanDate = "";

function cleanOldLogs(): void {
  const today = getDateStr();
  if (lastCleanDate === today) return;
  lastCleanDate = today;
  try {
    const entries = fs.readdirSync(LOG_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ARCHIVE_DAYS);
    const cutoffStr = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, "0")}${String(cutoff.getDate()).padStart(2, "0")}`;
    for (const entry of entries) {
      if (!entry.startsWith("tcb-") || !entry.endsWith(".jsonl")) continue;
      const dateStr = entry.slice(4, 12); // "tcb-YYYYMMDD.jsonl"
      if (dateStr < cutoffStr) {
        fs.unlinkSync(nodePath.join(LOG_DIR, entry));
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Strip secrets before writing. node-fetch error messages embed the failing
 * request URL which for the Bot API contains the token.
 */
export function redactSecrets(message: string): string {
  let out = message;
  for (const secret of [
    process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN,
    process.env.LARK_APP_SECRET,
  ]) {
    if (secret) out = out.split(secret).join("<redacted-token>");
  }
  return out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot<redacted-token>");
}

function write(level: LogLevel, message: string, ctx?: LogCtx): void {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: redactSecrets(message),
  };
  if (ctx?.session !== undefined) entry.session = ctx.session;
  if (ctx?.chatId !== undefined) entry.chatId = ctx.chatId;
  if (ctx?.channel !== undefined) entry.channel = ctx.channel;

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(getLogFile(getDateStr()), `${JSON.stringify(entry)}\n`, "utf-8");
    cleanOldLogs();
  } catch {
    // file write failed — no stdout fallback
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogCtx) => write("DEBUG", msg, ctx),
  info: (msg: string, ctx?: LogCtx) => write("INFO", msg, ctx),
  warn: (msg: string, ctx?: LogCtx) => write("WARN", msg, ctx),
  error: (msg: string, ctx?: LogCtx) => write("ERROR", msg, ctx),
};
