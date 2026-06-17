import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appStateFile } from "../../../shared/state-dir.js";
import type { HandlerDeps } from "../../deps.js";
import { messages } from "../../i18n/index.js";
import type { Channel } from "../../projects/project-manager.js";
import { getPathBySession } from "../../projects/sessionPathMap.js";
import { apiHost, formatUsageLines, numOrNull, type UsageSnapshot } from "../../read/usage.js";
import { listClaudeSessions } from "./claude-history.js";

/** Where the statusLine snapshot script writes, one file per claude session_id.
 * Lives under the bot's state dir so the app manages it; the install bakes this
 * absolute path into the generated script (the script can't resolve TCB_STATE_DIR). */
export function snapshotDir(): string {
  return appStateFile("status-snapshots");
}

/** Snapshots older than this are pruned and ignored — the data is real-time, and
 * a week covers the longest (7-day) rate-limit window. */
const STALE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

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

/** The usage snapshot for a tmux session: resolve its current claude session id
 * (newest transcript under the session's config root), then read that snapshot. */
async function resolveSnapshot(deps: HandlerDeps, session: string): Promise<UsageSnapshot | null> {
  const projectPath = getPathBySession(session);
  if (!projectPath) return null;
  const configRoot = await deps.configResolver.resolveConfigRoot(session);
  const sessionId = (await listClaudeSessions(projectPath, configRoot, 1))[0]?.sessionId;
  return sessionId ? readUsageSnapshot(sessionId) : null;
}

/**
 * Whether the bot's usage-snapshot integration is active for a claude config
 * root. True when our standalone statusLine script is set, OR our snapshot
 * snippet was pasted into the user's own statusLine script (snippet/wrap mode) —
 * detected by the baked snapshot-dir path appearing in that script. Used so
 * `/status` can tell "installed, but this session just has no snapshot yet" apart
 * from "not set up at all", and stop wrongly nudging to install when it IS.
 */
export function usageSnapshotInstalled(configRoot: string): boolean {
  let cmd: unknown;
  try {
    const settings = JSON.parse(fs.readFileSync(join(configRoot, "settings.json"), "utf8")) as {
      statusLine?: { command?: unknown };
    };
    cmd = settings.statusLine?.command;
  } catch {
    return false;
  }
  if (typeof cmd !== "string" || cmd.trim() === "") return false;

  const marker = snapshotDir(); // baked into our standalone script and our snippet
  const ourScript = join(marker, "statusline.sh");
  // Standalone or our-wrap: the command IS our script (optionally + a sidecar arg).
  if (cmd === ourScript || cmd.startsWith(`${ourScript} `)) return true;
  // Marker present as a discrete command token (inline snippet) — a whitespace-
  // split token that equals or starts with the marker path. NOT a bare substring
  // anywhere, so a custom script that merely mentions the path isn't a match.
  const tokens = cmd.split(/\s+/);
  if (tokens.some((t) => t === marker || t.startsWith(`${marker}/`))) return true;
  // Snippet mode: our block was pasted into the user's own *.sh — look inside it.
  const scriptTok = cmd.split(/\s+/).find((t) => t.endsWith(".sh"));
  if (scriptTok) {
    const path = scriptTok.startsWith("~") ? homedir() + scriptTok.slice(1) : scriptTok;
    try {
      return fs.readFileSync(path, "utf8").includes(marker);
    } catch {
      // unreadable script — fall through
    }
  }
  return false;
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
  const top: string[] = [running ? m.statusRunning("Claude") : m.statusNotRunning("Claude")];
  // Endpoint/auth of the running claude: API (key/token set) vs subscription
  // (claude.ai login), plus the base URL host. Best-effort; never shows the key.
  if (running) {
    const api = await deps.configResolver.resolveApiInfo?.(session);
    if (api) {
      const label = api.mode === "api" ? m.statusModeApi : m.statusModeSubscription;
      top.push(m.statusApiLine(label, apiHost(api.baseUrl, "api.anthropic.com")));
    }
  }
  if (now - lastPruneAt > PRUNE_THROTTLE_MS) {
    lastPruneAt = now;
    pruneStaleSnapshots(now);
  }
  // Usage reporting only makes sense for a running Claude. When it's stopped,
  // just report the state — no usage lines, no /status_install nudge (the hint
  // would be noise next to "not running").
  if (!running) return top.join("\n");
  const snap = await resolveSnapshot(deps, session);
  const lines = snap ? formatUsageLines(snap, channel, now) : [];
  if (lines.length > 0) return [...top, ...lines].join("\n");
  // A snapshot exists but carries no figures yet (null until Claude's first API
  // response) → "pending", never re-nudge to install.
  if (snap) return [...top, m.statusUsagePending].join("\n");
  // No snapshot for the resolved session. Only nudge to install when the snapshot
  // integration is genuinely ABSENT for this config dir; when it IS installed
  // (incl. snippet/wrap into a custom statusLine) this session simply has no data
  // yet — say so instead of the misleading "install it".
  const configRoot = await deps.configResolver.resolveConfigRoot(session);
  const noData = usageSnapshotInstalled(configRoot) ? m.statusUsageNoData : m.statusUsageHint;
  return [...top, noData].join("\n");
}
