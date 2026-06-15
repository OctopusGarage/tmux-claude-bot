import * as fs from "node:fs";
import { join } from "node:path";
import { appStateFile } from "../shared/state-dir.js";
import type { HandlerDeps } from "./deps.js";
import { listClaudeSessions } from "./history.js";
import { messages } from "./i18n/index.js";
import type { Channel } from "./project-manager.js";
import { getPathBySession } from "./sessionPathMap.js";

/** Where the statusLine snapshot script writes, one file per claude session_id.
 * Lives under the bot's state dir so the app manages it; the install bakes this
 * absolute path into the generated script (the script can't resolve TCB_STATE_DIR). */
export function snapshotDir(): string {
  return appStateFile("status-snapshots");
}

/** Snapshots older than this are pruned and ignored — the data is real-time, and
 * a week covers the longest (7-day) rate-limit window. */
const STALE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
/** Past this age the displayed usage is flagged as possibly out of date. */
const STALE_NOTICE_MS = 10 * 60 * 1000;

/** A usage snapshot persisted by the statusLine script. Percentages are 0–100 or
 * null (absent before the first API response, or for non-subscribers); reset and
 * updated times are epoch seconds. */
export interface UsageSnapshot {
  sessionId: string;
  contextPct: number | null;
  fiveHourPct: number | null;
  fiveHourReset: number | null;
  sevenDayPct: number | null;
  sevenDayReset: number | null;
  updatedAt: number;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse the snapshot file's snake_case JSON into a UsageSnapshot, or null. */
export function parseUsageSnapshot(raw: string): UsageSnapshot | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof j.session_id !== "string") return null;
  return {
    sessionId: j.session_id,
    contextPct: numOrNull(j.context_pct),
    fiveHourPct: numOrNull(j.five_hour_pct),
    fiveHourReset: numOrNull(j.five_hour_reset),
    sevenDayPct: numOrNull(j.seven_day_pct),
    sevenDayReset: numOrNull(j.seven_day_reset),
    updatedAt: numOrNull(j.updated_at) ?? 0,
  };
}

/** Read the snapshot for a session id, or null if none / unreadable. */
export function readUsageSnapshot(sessionId: string): UsageSnapshot | null {
  try {
    return parseUsageSnapshot(fs.readFileSync(join(snapshotDir(), `${sessionId}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Best-effort sweep of snapshots older than the TTL. Swallows all errors. */
export function pruneStaleSnapshots(now: number): void {
  const dir = snapshotDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      if (now - fs.statSync(join(dir, name)).mtimeMs > STALE_PRUNE_MS) {
        fs.unlinkSync(join(dir, name));
      }
    } catch {
      // racing prune / permission — ignore
    }
  }
}

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

/** Host of a base URL for display, or the default endpoint when unset. */
function apiHost(baseUrl: string | null): string {
  if (!baseUrl) return "api.anthropic.com";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
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

/** The usage snapshot for a tmux session: resolve its current claude session id
 * (newest transcript under the session's config root), then read that snapshot. */
async function resolveSnapshot(deps: HandlerDeps, session: string): Promise<UsageSnapshot | null> {
  const projectPath = getPathBySession(session);
  if (!projectPath) return null;
  const configRoot = await deps.configResolver.resolveConfigRoot(session);
  const sessionId = (await listClaudeSessions(projectPath, configRoot, 1))[0]?.sessionId;
  return sessionId ? readUsageSnapshot(sessionId) : null;
}

/** Throttle so the readdir-based prune runs at most hourly, not on every /status. */
const PRUNE_THROTTLE_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * The `/status` body: running state (computed by the caller), plus usage figures
 * when a snapshot exists. Degrades gracefully — without the statusLine
 * integration it's just the running-state line, exactly as before.
 */
export async function buildStatusReport(
  deps: HandlerDeps,
  session: string,
  channel: Channel,
  running: boolean,
  now: number = Date.now(),
): Promise<string> {
  const m = messages(channel);
  const top: string[] = [running ? m.statusRunning : m.statusNotRunning];
  // Endpoint/auth of the running claude: API (key/token set) vs subscription
  // (claude.ai login), plus the base URL host. Best-effort; never shows the key.
  if (running) {
    const api = await deps.configResolver.resolveApiInfo?.(session);
    if (api) {
      const label = api.mode === "api" ? m.statusModeApi : m.statusModeSubscription;
      top.push(m.statusApiLine(label, apiHost(api.baseUrl)));
    }
  }
  if (now - lastPruneAt > PRUNE_THROTTLE_MS) {
    lastPruneAt = now;
    pruneStaleSnapshots(now);
  }
  const snap = await resolveSnapshot(deps, session);
  const lines = snap ? formatUsageLines(snap, channel, now) : [];
  if (lines.length > 0) return [...top, ...lines].join("\n");
  // A snapshot exists (the statusLine IS installed) but carries no figures yet —
  // they're null until Claude's first API response. Don't re-nudge to install;
  // only do that when there's no snapshot at all.
  return [...top, snap ? m.statusUsagePending : m.statusUsageHint].join("\n");
}
