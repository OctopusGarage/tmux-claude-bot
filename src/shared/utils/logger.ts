import * as fs from "node:fs";
import * as nodePath from "node:path";
import { appStateFile } from "../state-dir.js";
import { currentLogContext } from "./log-context.js";

// Logs live under the app state home so they follow TCB_STATE_DIR like every
// other state dir; TCB_LOG_DIR still overrides for explicit redirection / tests.
const LOG_DIR = process.env.TCB_LOG_DIR ?? appStateFile("logs");
const MAX_ARCHIVE_DAYS = 30;

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

function errToObj(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: redactSecrets(err.message),
      ...(err.stack ? { stack: redactSecrets(err.stack) } : {}),
    };
  }
  return { name: "NonError", message: redactSecrets(String(err)) };
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
    ...(component ? { component } : {}),
    msg: redactSecrets(message),
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
      entry.data = JSON.parse(redactSecrets(JSON.stringify(ctx.data)));
    } catch (e) {
      entry.data = { _serializeError: String(e) };
    }
  }
  if (ctx?.err !== undefined) entry.err = errToObj(ctx.err);

  // Human mirror to stdout/stderr for launchd's logs + live `tail -f`. Suppressed
  // under Vitest so the structured-file assertions aren't drowned in console noise
  // (the JSONL file — what tests read — is still written below).
  if (level !== "DEBUG" && !process.env.VITEST) {
    const tag = component ? ` ${component}` : "";
    const line = `${entry.ts} ${level}${tag} ${entry.msg}`;
    if (level === "ERROR") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(getLogFile(getDateStr()), `${JSON.stringify(entry)}\n`, "utf-8");
    cleanOldLogs();
  } catch {
    // file write failed — the stdout mirror above is the fallback
  }
}

type ComponentLogger = {
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
