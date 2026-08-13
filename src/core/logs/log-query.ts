import * as fs from "node:fs";
import { join } from "node:path";
import { appStateFile } from "../../shared/state-dir.js";

export type LogRecord = {
  ts: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  pid?: number;
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
const MAX_LOG_DAYS = 30;
const SUMMARY_LIMIT = 10;

export type LogReadReport = {
  records: LogRecord[];
  files: number;
  bytes: number;
  malformedLines: number;
};

export type LogSummary = {
  records: number;
  files: number;
  bytes: number;
  malformedLines: number;
  from: string | null;
  to: string | null;
  levels: Record<LogRecord["level"], number>;
  topComponents: Array<{ component: string; count: number }>;
  topIssues: Array<{
    level: "WARN" | "ERROR";
    component: string;
    message: string;
    count: number;
  }>;
};

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

/** Read records plus integrity evidence from the newest bounded daily files. */
export function readLogReport(days = 1): LogReadReport {
  const LOG_DIR = logDir();
  let files: string[];
  try {
    files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("tcb-") && f.endsWith(".jsonl"))
      .sort();
  } catch {
    return { records: [], files: 0, bytes: 0, malformedLines: 0 };
  }
  const recent = files.slice(Math.max(0, files.length - days));
  const records: LogRecord[] = [];
  let bytes = 0;
  let malformedLines = 0;
  for (const file of recent) {
    let raw: string;
    try {
      raw = fs.readFileSync(join(LOG_DIR, file), "utf8");
    } catch {
      continue;
    }
    bytes += Buffer.byteLength(raw);
    // The current file can end in a torn append. Exclude only that incomplete
    // final line from integrity counts; malformed complete lines remain visible.
    const lines = raw.split("\n");
    if (!raw.endsWith("\n")) lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const record = parseLogRecord(JSON.parse(trimmed));
        if (record === null) malformedLines += 1;
        else records.push(record);
      } catch {
        malformedLines += 1;
      }
    }
  }
  return { records, files: recent.length, bytes, malformedLines };
}

/** Compatibility reader for callers that only need records. */
export function readRecords(days = 1): LogRecord[] {
  return readLogReport(days).records;
}

export function queryLogs(filter: LogFilter, days = 1): LogRecord[] {
  return filterRecords(readRecords(days), filter);
}

function parseLogRecord(value: unknown): LogRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.ts !== "string" ||
    !Number.isFinite(Date.parse(record.ts)) ||
    typeof record.level !== "string" ||
    !Object.hasOwn(ORDER, record.level) ||
    typeof record.msg !== "string"
  ) {
    return null;
  }
  return record as LogRecord;
}

export function parseLogDays(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`invalid --days "${value}" (expected an integer from 1 to ${MAX_LOG_DAYS})`);
  }
  const days = Number.parseInt(value, 10);
  if (days < 1 || days > MAX_LOG_DAYS) {
    throw new Error(`invalid --days "${value}" (expected an integer from 1 to ${MAX_LOG_DAYS})`);
  }
  return days;
}

export function summarizeLogs(
  records: readonly LogRecord[],
  read: Pick<LogReadReport, "files" | "bytes" | "malformedLines"> = {
    files: 0,
    bytes: 0,
    malformedLines: 0,
  },
): LogSummary {
  const levels: LogSummary["levels"] = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
  const components = new Map<string, number>();
  const issues = new Map<string, LogSummary["topIssues"][number]>();
  let from: string | null = null;
  let to: string | null = null;
  for (const record of records) {
    levels[record.level] += 1;
    const component = record.component ?? "-";
    components.set(component, (components.get(component) ?? 0) + 1);
    if (from === null || record.ts < from) from = record.ts;
    if (to === null || record.ts > to) to = record.ts;
    if (record.level === "WARN" || record.level === "ERROR") {
      const key = `${record.level}\0${component}\0${record.msg}`;
      const previous = issues.get(key);
      if (previous === undefined) {
        issues.set(key, {
          level: record.level,
          component,
          message: summaryMessage(record.msg),
          count: 1,
        });
      } else {
        previous.count += 1;
      }
    }
  }
  const byCountThenName =
    <T extends { count: number }>(label: (value: T) => string): ((left: T, right: T) => number) =>
    (left, right) =>
      right.count - left.count || label(left).localeCompare(label(right));
  return {
    records: records.length,
    files: read.files,
    bytes: read.bytes,
    malformedLines: read.malformedLines,
    from,
    to,
    levels,
    topComponents: [...components.entries()]
      .map(([component, count]) => ({ component, count }))
      .sort(byCountThenName((item) => item.component))
      .slice(0, SUMMARY_LIMIT),
    topIssues: [...issues.values()]
      .sort(byCountThenName((item) => `${item.level}:${item.component}:${item.message}`))
      .slice(0, SUMMARY_LIMIT),
  };
}

export function formatLogSummary(summary: LogSummary): string {
  const range = summary.from === null ? "no records" : `${summary.from} → ${summary.to}`;
  const lines = [
    `logs: ${summary.records} records · ${summary.files} file(s) · ${formatBytes(summary.bytes)} · ${range}`,
    `levels: ${summary.levels.ERROR} ERROR · ${summary.levels.WARN} WARN · ${summary.levels.INFO} INFO · ${summary.levels.DEBUG} DEBUG`,
    `integrity: ${summary.malformedLines} malformed complete line(s)`,
  ];
  if (summary.topComponents.length > 0) {
    lines.push(
      "top components:",
      ...summary.topComponents.map((item) => `  ${item.count} ${item.component}`),
    );
  }
  if (summary.topIssues.length > 0) {
    lines.push(
      "top WARN/ERROR issues:",
      ...summary.topIssues.map(
        (item) => `  ${item.count} ${item.level} ${item.component} · ${item.message}`,
      ),
    );
  }
  return lines.join("\n");
}

function summaryMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length <= 240 ? singleLine : `${singleLine.slice(0, 240)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
    if (!Object.hasOwn(ORDER, lvl))
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
