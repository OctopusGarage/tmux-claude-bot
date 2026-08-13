import * as fs from "node:fs";
import { join } from "node:path";
import { appStateFile } from "../../shared/state-dir.js";
import { iterJsonlObjects } from "../read/jsonl.js";

export type LogRecord = {
  ts: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  component?: string;
  msg: string;
  traceId?: string;
  session?: string;
  chatId?: string | number;
  channel?: "telegram" | "lark";
  data?: Record<string, unknown>;
  err?: { name: string; message: string; stack?: string };
};

export type LogFilter = {
  session?: string;
  trace?: string;
  chat?: string | number;
  channel?: "telegram" | "lark";
  component?: string;
  levelMin?: LogRecord["level"];
  grep?: string;
  runId?: string;
  since?: number; // epoch ms; keep records with ts >= since
  n?: number; // keep the last n after filtering
};

const ORDER: Record<LogRecord["level"], number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export function filterRecords(records: LogRecord[], f: LogFilter): LogRecord[] {
  const grep = f.grep?.toLowerCase();
  let out = records.filter((r) => {
    if (f.session && r.session !== f.session) return false;
    if (f.trace && r.traceId !== f.trace) return false;
    if (f.chat !== undefined && String(r.chatId) !== String(f.chat)) return false;
    if (f.channel && r.channel !== f.channel) return false;
    if (f.component && !(r.component ?? "").startsWith(f.component)) return false;
    if (f.levelMin && ORDER[r.level] < ORDER[f.levelMin]) return false;
    if (f.since !== undefined && Date.parse(r.ts) < f.since) return false;
    if (f.runId && !JSON.stringify(r).includes(f.runId)) return false;
    if (grep && !JSON.stringify(r).toLowerCase().includes(grep)) return false;
    return true;
  });
  if (f.n !== undefined && out.length > f.n) out = out.slice(out.length - f.n);
  return out;
}

/** The log directory, resolved per call so TCB_LOG_DIR is honored even when set
 * after this module loads (tests pin it late; the bot sets it before any query). */
function logDir(): string {
  return process.env.TCB_LOG_DIR ?? appStateFile("logs");
}

/** Read records from the daily files covering the last `days` days (inclusive). */
export function readRecords(days = 1): LogRecord[] {
  const LOG_DIR = logDir();
  let files: string[];
  try {
    files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("tcb-") && f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
  const recent = files.slice(Math.max(0, files.length - days));
  const out: LogRecord[] = [];
  for (const file of recent) {
    let raw: string;
    try {
      raw = fs.readFileSync(join(LOG_DIR, file), "utf8");
    } catch {
      continue;
    }
    // The logger appends to today's file live, so the tail can be a torn line;
    // iterJsonlObjects carries that skip-the-partial-line policy in one place.
    for (const rec of iterJsonlObjects<LogRecord>(raw)) out.push(rec);
  }
  return out;
}

export function queryLogs(filter: LogFilter, days = 1): LogRecord[] {
  return filterRecords(readRecords(days), filter);
}

export function argsToFilter(
  o: {
    session?: string;
    trace?: string;
    chat?: string;
    channel?: "telegram" | "lark";
    component?: string;
    level?: string;
    grep?: string;
    runId?: string;
    since?: string;
    n?: string;
  },
  now = Date.now(),
): LogFilter {
  const f: LogFilter = {};
  if (o.session) f.session = o.session;
  if (o.trace) f.trace = o.trace;
  if (o.chat) f.chat = o.chat;
  if (o.channel) f.channel = o.channel;
  if (o.component) f.component = o.component;
  if (o.level) {
    // Validate, don't blind-cast: an unknown level silently makes ORDER[f.levelMin]
    // undefined, so the comparison never excludes anything and ALL levels leak
    // through as if unfiltered. Reject it instead.
    const lvl = o.level.toUpperCase();
    if (!(lvl in ORDER))
      throw new Error(`invalid --level "${o.level}" (expected DEBUG|INFO|WARN|ERROR)`);
    f.levelMin = lvl as LogRecord["level"];
  }
  if (o.grep) f.grep = o.grep;
  if (o.runId) f.runId = o.runId;
  if (o.since) f.since = parseSince(o.since, now);
  if (o.n) {
    // A non-numeric/zero/negative N must not silently disable the cap (NaN makes
    // `out.length > f.n` false, dumping every record). Reject it.
    const n = Number.parseInt(o.n, 10);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`invalid -n "${o.n}" (expected a positive integer)`);
    f.n = n;
  }
  return f;
}

export function parseSince(value: string, now: number): number {
  const trimmed = value.trim();
  const relative = /^(\d+)([mhd])$/.exec(trimmed);
  if (relative !== null) {
    const amount = Number.parseInt(relative[1] ?? "", 10);
    const unit = relative[2];
    const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return now - amount * multiplier;
  }
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  throw new Error(
    `invalid --since "${value}" (expected ISO time, epoch ms, or relative 30m|2h|1d)`,
  );
}
