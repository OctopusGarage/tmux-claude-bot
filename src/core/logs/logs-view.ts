import type { LogFilter, LogRecord } from "./log-query.js";

/**
 * Turn the `/logs` chat argument into a {@link LogFilter}, given the current
 * session (may be undefined). Shared by both adapters so they behave identically:
 *   • no arg            → current session, WARN+, last 30
 *   • `t_…` (trace id)  → that trace, last 50 (session-independent)
 *   • numeric N         → current session, last N
 * Returns null when there's no session AND no trace arg (nothing safe to query).
 */
export function logsArgToFilter(
  arg: string | undefined,
  session: string | undefined,
  now = Date.now(),
): LogFilter | null {
  const a = arg?.trim();
  if (a?.startsWith("t_")) return { trace: a, n: 50 };
  if (!session) return null;
  if (a && /^\d+$/.test(a)) return { session, n: Number.parseInt(a, 10) };
  return { session, levelMin: "WARN", since: now - 3_600_000, n: 30 };
}

/** Render records into a compact chat block, keeping the NEWEST lines that fit. */
export function formatLogsForChat(records: LogRecord[], opts: { maxChars: number }): string {
  if (records.length === 0) return "No matching log entries.";
  const lines = records.map(
    (r) => `${r.ts.slice(11, 19)} ${r.level} ${r.component ?? "-"} ${r.msg}`,
  );
  let body = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = body ? `${lines[i]}\n${body}` : `${lines[i]}`;
    if (next.length > opts.maxChars) break;
    body = next;
  }
  return body;
}
