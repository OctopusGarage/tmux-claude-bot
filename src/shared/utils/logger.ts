import * as fs from "node:fs";
import * as nodePath from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = nodePath.resolve(__dirname, "../../logs");
const MAX_ARCHIVE_DAYS = 14;

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getDateStr(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getLogFileName(dateStr: string): string {
  return `bot-${dateStr}.log`;
}

function getErrorLogFile(dateStr: string): string {
  return `bot-${dateStr}-error.log`;
}

function cleanOldLogs(): void {
  try {
    const entries = fs.readdirSync(LOG_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ARCHIVE_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const entry of entries) {
      if (!entry.startsWith("bot-") || !entry.endsWith(".log")) continue;
      const dateStr = entry.slice(4, 14);
      if (dateStr < cutoffStr) {
        fs.unlinkSync(nodePath.join(LOG_DIR, entry));
      }
    }
  } catch {
    // ignore
  }
}

function resolveCallerFrame(): { file: string; line: number } {
  const stack = new Error().stack ?? "";
  const lines = stack.split("\n");

  // Walk stack to find first frame inside src/ but not in logger.ts
  for (const line of lines.slice(3)) {
    const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):\d+\)/);
    if (!match) continue;
    const filePath = match[2];
    const lineNum = match[3];
    if (filePath === undefined || lineNum === undefined) continue;
    if (filePath.includes("logger") || filePath.includes("node_modules")) continue;
    const fileName = filePath.split("/").pop() ?? filePath;
    return { file: `${fileName}`, line: parseInt(lineNum, 10) };
  }

  return { file: "unknown", line: 0 };
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

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

function getLocalTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const offH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const offM = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${h}:${m}:${s}.${ms}${sign}${offH}:${offM}`;
}

const levelColor: Record<LogLevel, string> = {
  DEBUG: "\x1b[90m",
  INFO: "\x1b[36m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
};
const levelBold: Record<LogLevel, string> = {
  DEBUG: "\x1b[2m",
  INFO: "\x1b[1m",
  WARN: "\x1b[1m",
  ERROR: "\x1b[1m",
};
const RESET = "\x1b[0m";

function formatLine(level: LogLevel, file: string, line: number, message: string): string {
  const local = getLocalTime();
  const paddedLevel = level.padEnd(5, " ");
  return `${local} ${paddedLevel} ${file}:${line} ${message}`;
}

/**
 * Strip the Telegram bot token before anything is written. node-fetch error
 * messages embed the failing request URL, which for the Bot API contains the
 * secret (…/bot<id>:<secret>/…). Redacting the exact env token plus the generic
 * URL pattern keeps the credential out of console output and log files.
 */
export function redactSecrets(message: string): string {
  const token = process.env.BOT_TOKEN;
  const withoutToken = token ? message.split(token).join("<redacted-token>") : message;
  return withoutToken.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot<redacted-token>");
}

function write(level: LogLevel, message: string): void {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;

  const { file, line } = resolveCallerFrame();
  const formatted = formatLine(level, file, line, redactSecrets(message));
  const dateStr = getDateStr();

  // Console output with color
  const color = levelColor[level];
  const bold = levelBold[level];
  if (level === "ERROR") {
    console.error(`${color}${bold}${formatted}${RESET}`);
  } else {
    console.log(`${color}${bold}${formatted}${RESET}`);
  }

  // File output (plain text, no ANSI codes)
  try {
    ensureLogDir();

    const logFile = nodePath.join(LOG_DIR, getLogFileName(dateStr));
    fs.appendFileSync(logFile, `${formatted}\n`, "utf-8");

    if (level === "ERROR" || level === "WARN") {
      const errFile = nodePath.join(LOG_DIR, getErrorLogFile(dateStr));
      fs.appendFileSync(errFile, `${formatted}\n`, "utf-8");
    }

    cleanOldLogs();
  } catch {
    // file write failed, console already got it
  }
}

function argsToString(...args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export const logger = {
  debug: (...args: unknown[]) => write("DEBUG", argsToString(...args)),
  info: (...args: unknown[]) => write("INFO", argsToString(...args)),
  warn: (...args: unknown[]) => write("WARN", argsToString(...args)),
  error: (...args: unknown[]) => write("ERROR", argsToString(...args)),
};
