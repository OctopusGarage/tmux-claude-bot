import type { UsageSnapshot } from "../read/usage.js";
import type { DashboardSnapshot, SessionRow } from "./dashboard.js";

/** Compact human-readable duration from milliseconds.
 * <60s → "Ns"; <60m → "Nm" or "NmSs"; <24h → "Nh" or "NhMm"; else "NdMh". */
export function humanizeMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHour = Math.floor(totalMin / 60);
  const totalDay = Math.floor(totalHour / 24);

  if (totalSec < 60) return `${totalSec}s`;

  if (totalMin < 60) {
    const s = totalSec % 60;
    return s > 0 ? `${totalMin}m${s}s` : `${totalMin}m`;
  }

  if (totalHour < 24) {
    const m = totalMin % 60;
    return m > 0 ? `${totalHour}h${m}m` : `${totalHour}h`;
  }

  const h = totalHour % 24;
  return h > 0 ? `${totalDay}d${h}h` : `${totalDay}d`;
}

function formatAdapters(adapters: { telegram: boolean; lark: boolean }): string {
  const parts: string[] = [];
  if (adapters.telegram) parts.push("TG");
  if (adapters.lark) parts.push("Lark");
  return parts.length > 0 ? parts.join("+") : "none";
}

function formatUsageParts(usage: UsageSnapshot): string {
  const parts: string[] = [];
  if (usage.contextPct !== null) parts.push(`ctx ${usage.contextPct}%`);
  if (usage.fiveHourPct !== null) parts.push(`5h ${usage.fiveHourPct}%`);
  if (usage.sevenDayPct !== null) parts.push(`7d ${usage.sevenDayPct}%`);
  return parts.join(" ");
}

function formatSessionLine(row: SessionRow): string {
  const glyph = row.busy ? "▶" : "○";
  const state = row.busy
    ? row.taskMs !== undefined
      ? `busy task ${humanizeMs(row.taskMs)}`
      : "busy"
    : "idle";
  const uptime = `up ${humanizeMs(row.uptimeMs)}`;
  const usage = row.usage ? formatUsageParts(row.usage) : "";
  const cumulative = row.cumulativeBusyMs > 0 ? `total ${humanizeMs(row.cumulativeBusyMs)}` : "";
  // api vs subscription matters operationally (which sessions burn API credits),
  // so surface it next to the kind: e.g. "(claude/sub)", "(codex/api)".
  const apiTag = row.apiMode ? `/${row.apiMode === "subscription" ? "sub" : "api"}` : "";

  const parts = [
    `${glyph} ${row.label} (${row.kind}${apiTag})`,
    state,
    uptime,
    usage,
    cumulative,
  ].filter(Boolean);

  return parts.join(" · ");
}

function formatHeader(s: DashboardSnapshot): string {
  const uptime = s.global.botUptimeMs !== null ? humanizeMs(s.global.botUptimeMs) : "?";
  const adapters = formatAdapters(s.global.adapters);
  return (
    `🤖 tmux-claude-bot v${s.global.version} · up ${uptime} · ` +
    `${s.global.sessionCount} sessions (${s.global.busyCount} busy) · ` +
    `queue ${s.global.queueDepth} · ${adapters}`
  );
}

/** Render a full text dashboard: header + one line per session. */
export function formatDashboardText(s: DashboardSnapshot): string {
  const lines = [formatHeader(s), ...s.sessions.map(formatSessionLine)];
  return lines.join("\n");
}

/** Render a chat-friendly dashboard capped at `maxChars`.
 * Header is always included; session lines are appended while they fit.
 * If lines are dropped, a `…(+N more)` trailer is appended when it still fits. */
export function formatDashboardForChat(
  s: DashboardSnapshot,
  { maxChars }: { maxChars: number },
): string {
  const header = formatHeader(s);
  const sessionLines = s.sessions.map(formatSessionLine);

  let result = header;
  let included = 0;

  for (const line of sessionLines) {
    const candidate = `${result}\n${line}`;
    if (candidate.length <= maxChars) {
      result = candidate;
      included++;
    } else {
      break;
    }
  }

  const dropped = sessionLines.length - included;
  if (dropped > 0) {
    const trailer = `\n…(+${dropped} more)`;
    if ((result + trailer).length <= maxChars) {
      result += trailer;
    }
  }

  return result;
}
