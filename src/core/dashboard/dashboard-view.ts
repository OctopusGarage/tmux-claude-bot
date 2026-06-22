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
  if (usage.contextPct !== null) parts.push(`ctx ${Math.round(usage.contextPct)}%`);
  if (usage.fiveHourPct !== null) parts.push(`5h ${Math.round(usage.fiveHourPct)}%`);
  if (usage.sevenDayPct !== null) parts.push(`7d ${Math.round(usage.sevenDayPct)}%`);
  return parts.length > 0 ? `📊 ${parts.join(" · ")}` : "";
}

/** One session as two lines: a status-dot + name headline, then an indented
 * detail line (kind/api · state · uptime · usage · cumulative). Emoji-labeled
 * so it stays scannable as plain chat text (no monospace column alignment). */
function formatSessionBlock(row: SessionRow): string {
  // Three states: 🟢 busy (agent working) · 🟡 idle (agent up, waiting) · ⚫ stopped
  // (no agent in the pane — a shell, or the agent exited). The middle/last were
  // previously both ⚪, so a stopped session looked the same as an idle one.
  const dot = row.busy ? "🟢" : row.running ? "🟡" : "⚫";
  // api vs subscription matters operationally (which sessions burn API credits).
  const apiTag = row.apiMode ? `/${row.apiMode === "subscription" ? "sub" : "api"}` : "";
  const kind = `🤖 ${row.kind}${apiTag}`;
  // Same precedence as the dot (busy → running → stopped): a session can read busy
  // from recent activity while its agent has just exited (running=false), and there
  // it should show 🔥 busy, not ⏹ stopped — matching its 🟢 dot.
  const state = row.busy
    ? row.taskMs !== undefined
      ? `🔥 busy ${humanizeMs(row.taskMs)}`
      : "🔥 busy"
    : row.running
      ? "💤 idle"
      : "⏹ stopped";
  const uptime = `⏱ up ${humanizeMs(row.uptimeMs)}`;
  const usage = row.usage ? formatUsageParts(row.usage) : "";
  const total = row.cumulativeBusyMs > 0 ? `Σ ${humanizeMs(row.cumulativeBusyMs)}` : "";
  const auto = row.autopilot ? `✈️ auto·${row.autopilot.iterations}` : "";

  const detail = [kind, state, uptime, usage, total, auto].filter(Boolean).join(" · ");
  return `${dot} ${row.label}\n   ↳ ${detail}`;
}

/** The compact fleet summary line(s) shown at the top of the dashboard / TUI:
 * bot version + uptime, session counts, queue depth, and connected adapters. */
export function formatHeader(s: DashboardSnapshot): string {
  const uptime = s.global.botUptimeMs !== null ? humanizeMs(s.global.botUptimeMs) : "?";
  const adapters = formatAdapters(s.global.adapters);
  const autoSuffix = s.global.autopilotCount > 0 ? ` · ✈️ ${s.global.autopilotCount} auto` : "";
  return (
    `🤖 tmux-claude-bot · v${s.global.version}\n` +
    `⏱ up ${uptime} · 🗂 ${s.global.sessionCount} sessions · ` +
    `▶ ${s.global.runningCount} running · 🟢 ${s.global.busyCount} busy · ` +
    `📬 queue ${s.global.queueDepth} · 🔌 ${adapters}${autoSuffix}`
  );
}

/** Assemble header + a blank line + the session blocks (header only when empty). */
function assemble(header: string, blocks: string[]): string {
  return blocks.length > 0 ? `${header}\n\n${blocks.join("\n")}` : header;
}

/** Render a full text dashboard: header + one block per session. */
export function formatDashboardText(s: DashboardSnapshot): string {
  return assemble(formatHeader(s), s.sessions.map(formatSessionBlock));
}

/** Render a chat-friendly dashboard capped at `maxChars`.
 * Header is always included; session blocks are appended while they fit (a blank
 * line separates the header). If blocks are dropped, a `…(+N more)` trailer is
 * appended when it still fits. */
export function formatDashboardForChat(
  s: DashboardSnapshot,
  { maxChars }: { maxChars: number },
): string {
  const header = formatHeader(s);
  const blocks = s.sessions.map(formatSessionBlock);

  let result = header;
  let included = 0;
  for (let i = 0; i < blocks.length; i++) {
    const sep = i === 0 ? "\n\n" : "\n"; // blank line after the header only
    const candidate = `${result}${sep}${blocks[i]}`;
    if (candidate.length <= maxChars) {
      result = candidate;
      included++;
    } else {
      break;
    }
  }

  const dropped = blocks.length - included;
  if (dropped > 0) {
    const trailer = `\n…(+${dropped} more)`;
    if ((result + trailer).length <= maxChars) result += trailer;
  }

  return result;
}
