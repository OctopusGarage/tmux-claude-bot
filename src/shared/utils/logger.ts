import * as fs from "node:fs";
import * as nodePath from "node:path";
import { appStateFile } from "../state-dir.js";
import { currentLogContext } from "./log-context.js";

// Logs live under the app state home so they follow TCB_STATE_DIR like every
// other state dir; TCB_LOG_DIR still overrides for explicit redirection / tests.
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
