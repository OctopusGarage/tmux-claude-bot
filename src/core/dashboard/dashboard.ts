import type { AgentKind } from "../../shared/types.js";
import { sleep } from "../../shared/utils/sleep.js";
import { appVersion } from "../../shared/version.js";
import { resolveAgentKind } from "../agents/agentKindMap.js";
import { profileFor } from "../agents/registry.js";
import type { HandlerDeps } from "../deps.js";
import { instanceStartedAt } from "../infra/instance-lock.js";
import { projectLabel } from "../projects/project-label.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import type { UsageSnapshot } from "../read/usage.js";
import { cumulativeBusyMs as cumulativeBusyMsOf, currentTask } from "../session/task-timing.js";

/** A transcript written within this window counts the session as actively
 * working. Generous so brief gaps between streamed writes don't flip to idle;
 * the cost is up to this much "busy" lag after a task actually finishes. */
const ACTIVITY_WINDOW_MS = 60_000;

/** Gap between the two pane captures used to detect activity by animation. An
 * actively-working pane has a cycling spinner and a ticking elapsed timer (main
 * turn, a silent tool call, or a running background task), so two captures this
 * far apart differ; an idle pane is static. >1s so a 1s-resolution timer is sure
 * to tick between them. */
const PANE_DIFF_MS = 1_100;

/** True if the session's pane changed across a ~PANE_DIFF_MS gap — i.e. something
 * is animating (spinner/timer/streaming), which means the agent is working even
 * when it wrote no transcript (a long silent tool call) and drove no bot task.
 * Agent-agnostic: no fragile UI-string match. Best-effort: a capture failure or a
 * static pane reads as not-busy. */
async function paneIsAnimating(
  deps: HandlerDeps,
  session: string,
  diffMs: number,
): Promise<boolean> {
  const a = await deps.bridge.capturePane(session).catch(() => null);
  if (a === null) return false;
  await sleep(diffMs);
  const b = await deps.bridge.capturePane(session).catch(() => null);
  return b !== null && b !== a;
}

/**
 * One live session's aggregated state for the dashboard. Neutral data only —
 * rendering (CLI/chat) lives in later tasks.
 */
export type SessionRow = {
  session: string;
  label: string;
  kind: AgentKind;
  busy: boolean;
  taskMs?: number;
  cumulativeBusyMs: number;
  uptimeMs: number;
  usage: UsageSnapshot | null;
  apiMode?: "api" | "subscription";
};

/** A global snapshot: every live session plus bot-level totals. */
export type DashboardSnapshot = {
  sessions: SessionRow[];
  global: {
    botUptimeMs: number | null;
    version: string;
    sessionCount: number;
    busyCount: number;
    queueDepth: number;
    adapters: { telegram: boolean; lark: boolean };
  };
  generatedAt: number;
};

/**
 * Build one session row, best-effort. Each external read is isolated in its own
 * try/catch so a single failure degrades that field rather than the whole row —
 * this function NEVER throws, it always returns a row. Kind defaults to "claude"
 * on failure (matching the persisted-map default), usage to null, apiMode to
 * undefined.
 */
async function gatherRow(
  deps: HandlerDeps,
  session: string,
  created: Map<string, number>,
  now: number,
  paneDiffMs: number,
): Promise<SessionRow> {
  // Best-effort like the usage/apiMode reads below; default to "claude" (matching
  // the persisted-map default) if the live probe fails.
  const kind = await resolveAgentKind(deps.configResolver, session).catch(
    (): AgentKind => "claude",
  );

  const projectPath = getPathBySession(session);
  const label = projectLabel(session, projectPath ?? undefined);

  const ct = currentTask(session, now);
  const cumulativeBusyMs = cumulativeBusyMsOf(session, now);
  const createdAt = created.get(session);
  const uptimeMs = createdAt !== undefined ? Math.max(0, now - createdAt * 1000) : 0;

  const profile = profileFor(kind);
  let usage: UsageSnapshot | null = null;
  let lastActivity: number | null = null;
  if (projectPath) {
    [usage, lastActivity] = await Promise.all([
      profile.readUsage(deps.configResolver, session, projectPath).catch(() => null),
      profile.lastActivityAt?.(deps.configResolver, session, projectPath).catch(() => null) ??
        Promise.resolve(null),
    ]);
  }

  // Busy = the bot is driving a task OR the agent wrote its transcript recently.
  // The transcript-mtime arm catches work started directly in the pane (no bot
  // task), so a desktop-driven session shows busy too — it just has no task
  // duration.
  const liveActive = lastActivity !== null && now - lastActivity < ACTIVITY_WINDOW_MS;
  let busy = ct.busy || liveActive;
  // Only when the cheap signals say idle, fall back to the pane-animation check:
  // it catches a long silent tool call or a background subagent (both tick a
  // timer / spin) that writes no transcript and drove no bot task. Skipped for
  // already-busy sessions to avoid the extra captures + the diff delay.
  if (!busy) busy = await paneIsAnimating(deps, session, paneDiffMs);

  const apiMode = (await deps.configResolver.resolveApiInfo?.(session).catch(() => null))?.mode;

  return {
    session,
    label,
    kind,
    busy,
    ...(ct.sinceMs !== undefined && { taskMs: ct.sinceMs }),
    cumulativeBusyMs,
    uptimeMs,
    usage,
    ...(apiMode !== undefined && { apiMode }),
  };
}

/**
 * Gather a global snapshot of all live sessions plus bot-level totals.
 * Rows are gathered concurrently and best-effort: one failing session does not
 * sink the rest (see {@link gatherRow}), and the session-creation-time lookup
 * already degrades to an empty map on failure.
 */
export async function buildDashboard(
  deps: HandlerDeps,
  opts: { paneDiffMs?: number } = {},
): Promise<DashboardSnapshot> {
  const paneDiffMs = opts.paneDiffMs ?? PANE_DIFF_MS;
  const now = Date.now();
  // Two independent tmux reads — run them concurrently rather than back-to-back.
  const [created, names] = await Promise.all([
    deps.bridge.sessionsCreatedAt(),
    deps.bridge.listProjectSessions(),
  ]);
  const rows = await Promise.all(names.map((s) => gatherRow(deps, s, created, now, paneDiffMs)));

  const st = instanceStartedAt();
  const botUptimeMs = st ? Math.max(0, now - Date.parse(st)) : null;

  return {
    sessions: rows,
    global: {
      botUptimeMs,
      version: appVersion(),
      sessionCount: rows.length,
      busyCount: rows.filter((r) => r.busy).length,
      queueDepth: deps.queue.size(),
      adapters: {
        telegram: Boolean(deps.config.telegramBotToken),
        lark: Boolean(deps.config.lark),
      },
    },
    generatedAt: now,
  };
}
