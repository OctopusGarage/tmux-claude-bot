import { messages } from "../i18n/index.js";
import type { Channel } from "../projects/project-manager.js";

/**
 * Agent-neutral usage shape + rendering shared by claude and codex. Each agent
 * sources the figures its own way (claude: a statusLine snapshot file; codex: the
 * rollout JSONL tail) into this snapshot; the bar/percentage/reset rendering is
 * shared so both `/status` reports look identical.
 */

/** A usage snapshot. Percentages are 0–100 or null (absent before the first API
 * response, or for non-subscribers); reset and updated times are epoch seconds. */
export interface UsageSnapshot {
  sessionId: string;
  contextPct: number | null;
  fiveHourPct: number | null;
  fiveHourReset: number | null;
  sevenDayPct: number | null;
  sevenDayReset: number | null;
  updatedAt: number;
}

/** JSON-number coercion guard used when building a UsageSnapshot — a finite
 * number passes through; anything else (string, null, NaN, Infinity) → null.
 * Shared so both agents' snapshot builders coerce identically. */
export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Host of a base URL for a /status line, or `defaultHost` when the URL is unset
 * or unparseable. Shared so both agents' status lines extract the host the same
 * way (only the default endpoint differs: api.anthropic.com vs api.openai.com). */
export function apiHost(baseUrl: string | null, defaultHost: string): string {
  if (!baseUrl) return defaultHost;
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** Past this age the displayed usage is flagged as possibly out of date. */
const STALE_NOTICE_MS = 10 * 60 * 1000;
const BAR_WIDTH = 10;

function usageEmoji(pct: number): string {
  if (pct >= 90) return "🔴";
  if (pct >= 50) return "🟡";
  return "🟢";
}

function bar(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return `${usageEmoji(p)} ${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

/** Format an epoch-seconds reset time as local `MM-DD HH:MM` (language-neutral). */
function fmtReset(epochSec: number | null): string {
  if (epochSec === null) return "?";
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Render the usage lines (context / 5h / weekly) present in a snapshot, plus a
 * staleness note when the data is old. Empty when the snapshot carries no figures. */
export function formatUsageLines(snap: UsageSnapshot, channel: Channel, now: number): string[] {
  const m = messages(channel);
  const lines: string[] = [];
  if (snap.contextPct !== null)
    lines.push(m.statusContext(bar(snap.contextPct), Math.round(snap.contextPct)));
  if (snap.fiveHourPct !== null) {
    lines.push(
      m.statusFiveHour(
        bar(snap.fiveHourPct),
        Math.round(snap.fiveHourPct),
        fmtReset(snap.fiveHourReset),
      ),
    );
  }
  if (snap.sevenDayPct !== null) {
    lines.push(
      m.statusSevenDay(
        bar(snap.sevenDayPct),
        Math.round(snap.sevenDayPct),
        fmtReset(snap.sevenDayReset),
      ),
    );
  }
  if (lines.length > 0 && now - snap.updatedAt * 1000 > STALE_NOTICE_MS) {
    lines.push(m.statusUsageStale(Math.round((now - snap.updatedAt * 1000) / 60000)));
  }
  return lines;
}
