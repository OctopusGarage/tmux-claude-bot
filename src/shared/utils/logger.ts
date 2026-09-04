import * as fs from "node:fs";
import * as nodePath from "node:path";
import { appStateFile } from "../state-dir.js";
import { currentLogContext } from "./log-context.js";

// Logs live under the app state home so they follow TCB_STATE_DIR like every
// other state dir; TCB_LOG_DIR still overrides for explicit redirection / tests.
const MAX_ARCHIVE_DAYS = 30;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_ERROR_STACK_CHARS = 16_000;
const MAX_DATA_BYTES = 32 * 1024;
const MAX_VALUE_DEPTH = 8;
const MAX_COLLECTION_ITEMS = 100;
const REDACTED = "<redacted>";

export type LogCtx = {
  session?: string;
  chatId?: string | number;
  channel?: "telegram" | "lark";
  data?: Record<string, unknown>;
  err?: unknown;
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

/** Local-time YYYYMMDD — the daily log-file stamp and the rotation-cutoff key. */
function ymd(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function getDateStr(): string {
  return ymd(new Date());
}

function logDir(): string {
  return process.env.TCB_LOG_DIR ?? appStateFile("logs");
}

function getLogFile(dir: string, dateStr: string): string {
  return nodePath.join(dir, `tcb-${dateStr}.jsonl`);
}

let lastCleanKey = "";
// The log dir is created once and persists; skip the per-write mkdir syscall.
// Clear the cached path on a write failure so a removed dir is re-created next time.
let readyDir = "";

function cleanOldLogs(dir: string): void {
  const today = getDateStr();
  const cleanKey = `${dir}\0${today}`;
  if (lastCleanKey === cleanKey) return;
  lastCleanKey = cleanKey;
  try {
    const entries = fs.readdirSync(dir);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ARCHIVE_DAYS);
    const cutoffStr = ymd(cutoff);
    for (const entry of entries) {
      if (!entry.startsWith("tcb-") || !entry.endsWith(".jsonl")) continue;
      const dateStr = entry.slice(4, 12); // "tcb-YYYYMMDD.jsonl"
      if (dateStr < cutoffStr) {
        fs.unlinkSync(nodePath.join(dir, entry));
      }
    }
    const retained = fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith("tcb-") && entry.endsWith(".jsonl"))
      .map((entry) => {
        const path = nodePath.join(dir, entry);
        return { entry, path, bytes: fs.statSync(path).size };
      })
      .sort((left, right) => left.entry.localeCompare(right.entry));
    let totalBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of retained) {
      if (totalBytes <= MAX_ARCHIVE_BYTES) break;
      if (item.entry.startsWith(`tcb-${today}`)) continue;
      fs.unlinkSync(item.path);
      totalBytes -= item.bytes;
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
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
  ]) {
    if (secret) out = out.split(secret).join("<redacted-token>");
  }
  return out
    .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot<redacted-token>")
    .replace(/\b(?:gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b/g, REDACTED)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/((?:proxy-)?authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(
      /([?&](?:access_token|refresh_token|token|api[_-]?key|secret|password)=)[^&\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:[A-Z0-9_]*token|access[_-]?token|refresh[_-]?token|api[_-]?key|app[_-]?secret|password)\s*[=:]\s*)(?!<redacted)[^\s,;]+/gi,
      `$1${REDACTED}`,
    );
}

function errToObj(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: truncate(redactSecrets(err.message), MAX_MESSAGE_CHARS),
      ...(err.stack ? { stack: truncate(redactSecrets(err.stack), MAX_ERROR_STACK_CHARS) } : {}),
    };
  }
  return {
    name: "NonError",
    message: truncate(redactSecrets(String(err)), MAX_MESSAGE_CHARS),
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return (
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized.endsWith("cookie") ||
    normalized === "apikey" ||
    normalized === "credential" ||
    normalized === "credentials"
  );
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncate(redactSecrets(value), MAX_MESSAGE_CHARS);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_VALUE_DEPTH) return "[MaxDepth]";
  if (seen.has(value)) throw new TypeError("circular log data");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen));
      if (value.length > MAX_COLLECTION_ITEMS) {
        items.push(`[Truncated ${value.length - MAX_COLLECTION_ITEMS} items]`);
      }
      return items;
    }
    const entries = Object.entries(value).slice(0, MAX_COLLECTION_ITEMS);
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      output[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(item, depth + 1, seen);
    }
    if (Object.keys(value).length > MAX_COLLECTION_ITEMS) {
      output._truncatedKeys = Object.keys(value).length - MAX_COLLECTION_ITEMS;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeValue(data, 0, new WeakSet()) as Record<string, unknown>;
  const json = JSON.stringify(sanitized);
  const bytes = Buffer.byteLength(json);
  if (bytes <= MAX_DATA_BYTES) return sanitized;
  return {
    _truncated: true,
    _originalBytes: bytes,
    preview: truncate(json, MAX_DATA_BYTES - 200),
  };
}

function write(
  level: LogLevel,
  component: string | undefined,
  message: string,
  ctx?: LogCtx,
): void {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;
  const ambient = currentLogContext();

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    ...(component ? { component } : {}),
    msg: truncate(redactSecrets(message), MAX_MESSAGE_CHARS),
  };
  const traceId = ambient.traceId;
  const session = ctx?.session ?? ambient.session;
  const chatId = ctx?.chatId ?? ambient.chatId;
  const channel = ctx?.channel ?? ambient.channel;
  if (traceId !== undefined) entry.traceId = traceId;
  if (session !== undefined) entry.session = session;
  if (chatId !== undefined) entry.chatId = chatId;
  if (channel !== undefined) entry.channel = channel;
  if (ctx?.data !== undefined) {
    // Never let a non-serializable payload (circular ref, BigInt) throw into the
    // caller — logging is best-effort. Fall back to a marker on failure.
    try {
      entry.data = sanitizeData(ctx.data);
    } catch (e) {
      entry.data = {
        _serializeError: truncate(redactSecrets(String(e)), MAX_MESSAGE_CHARS),
      };
    }
  }
  if (ctx?.err !== undefined) entry.err = errToObj(ctx.err);

  // Human mirror to stdout/stderr for launchd's logs + live `tail -f`. Suppressed
  // under Vitest so the structured-file assertions aren't drowned in console noise
  // (the JSONL file — what tests read — is still written below).
  if (level !== "DEBUG" && !process.env.VITEST && !process.env.TCB_LOG_QUIET) {
    const tag = component ? ` ${component}` : "";
    const line = `${entry.ts} ${level}${tag} ${entry.msg}`;
    if (level === "ERROR") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  try {
    const dir = logDir();
    if (readyDir !== dir) {
      fs.mkdirSync(dir, { recursive: true });
      readyDir = dir;
    }
    fs.appendFileSync(getLogFile(dir, getDateStr()), `${JSON.stringify(entry)}\n`, "utf-8");
    cleanOldLogs(dir);
  } catch {
    // file write failed — the stdout mirror above is the fallback. Re-mkdir next
    // time in case the dir was removed out from under us.
    readyDir = "";
  }
}

export type ComponentLogger = {
  debug: (msg: string, ctx?: LogCtx) => void;
  info: (msg: string, ctx?: LogCtx) => void;
  warn: (msg: string, ctx?: LogCtx) => void;
  error: (msg: string, ctx?: LogCtx) => void;
};

export function createLogger(component: string): ComponentLogger {
  return {
    debug: (msg, ctx) => write("DEBUG", component, msg, ctx),
    info: (msg, ctx) => write("INFO", component, msg, ctx),
    warn: (msg, ctx) => write("WARN", component, msg, ctx),
    error: (msg, ctx) => write("ERROR", component, msg, ctx),
  };
}

export const logger: ComponentLogger = {
  debug: (msg, ctx) => write("DEBUG", undefined, msg, ctx),
  info: (msg, ctx) => write("INFO", undefined, msg, ctx),
  warn: (msg, ctx) => write("WARN", undefined, msg, ctx),
  error: (msg, ctx) => write("ERROR", undefined, msg, ctx),
};
