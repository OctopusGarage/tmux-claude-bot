import type { AgentKind } from "../../shared/types.js";
import { appVersion } from "../../shared/version.js";
import { readAgentActivitySnapshot } from "../agents/activity-snapshot.js";
import { AutopilotStore } from "../autopilot/state-store.js";
import type { HandlerDeps } from "../deps.js";
import { instanceStartedAt } from "../infra/instance-lock.js";
import { freeLabel, freeSlotOf, getFreeProject } from "../projects/free-projects.js";
import { bindingForSession } from "../projects/group-bindings.js";
import { isOperator } from "../projects/operator.js";
import { projectLabel } from "../projects/project-label.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import type { UsageSnapshot } from "../read/usage.js";
import { PANE_DIFF_MS } from "../session/pane-activity.js";
import { SESSION_ACTIVITY_WINDOW_MS } from "../session/session-telemetry.js";

/** A transcript written within this window counts the session as actively
 * working. Generous so brief gaps between streamed writes don't flip to idle;
 * the cost is up to this much "busy" lag after a task actually finishes. */
const ACTIVITY_WINDOW_MS = SESSION_ACTIVITY_WINDOW_MS;

const autopilotStore = new AutopilotStore();

/**
 * One live session's aggregated state for the dashboard. Neutral data only —
 * rendering (CLI/chat) lives in later tasks.
 */
export type SessionRow = {
  session: string;
  label: string;
  sessionKind: "regular" | "independent" | "operator";
  workspacePath: string | null;
  independentSlot: number | null;
  group: { chatId: string; label: string } | null;
  kind: AgentKind;
  /** Whether an agent process is alive in the pane. A tmux session can exist with
   * NO agent (shell prompt, or the agent exited) — distinguishing that from an
   * idle-but-running agent is why this is separate from `busy`. Independent of
   * `busy`: a session can read `busy` from recent transcript activity yet have no
   * live agent (it just exited), so this is process-probed, not derived. */
  running: boolean;
  busy: boolean;
  taskMs?: number;
  task?: {
    key: string;
    startedAt: number;
    source: "queue" | "transcript";
  };
  cumulativeBusyMs: number;
  uptimeMs: number;
  usage: UsageSnapshot | null;
  apiMode?: "api" | "subscription";
  /** Present only when autopilot is enabled for this session. */
  autopilot?: { enabled: boolean; pureKeepAlive: boolean; iterations: number };
  /** True when this row is the reserved operator (home) session. */
  operator?: boolean;
};

/** A global snapshot: every live session plus bot-level totals. */
export type DashboardSnapshot = {
  sessions: SessionRow[];
  global: {
    botUptimeMs: number | null;
    version: string;
    sessionCount: number;
    /** Sessions with a live agent process (started). The rest are stopped shells. */
    runningCount: number;
    busyCount: number;
    queueDepth: number;
    adapters: { telegram: boolean; lark: boolean };
    autopilotCount: number;
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
  const projectPath = getPathBySession(session);
  const prefix = deps.config.projectSessionPrefix;
  const operatorFlag = isOperator(session, prefix);
  const independentSlot = freeSlotOf(session, prefix);
  const sessionKind = operatorFlag
    ? "operator"
    : independentSlot !== null
      ? "independent"
      : "regular";
  const groupBinding = bindingForSession(session);
  const label =
    independentSlot !== null
      ? freeLabel(independentSlot, getFreeProject(independentSlot), projectPath)
      : projectLabel(session, projectPath ?? undefined);

  const createdAt = created.get(session);
  const uptimeMs = createdAt !== undefined ? Math.max(0, now - createdAt * 1000) : 0;

  const activity = await readAgentActivitySnapshot(deps, session, {
    boundPath: projectPath,
    now,
    activityWindowMs: ACTIVITY_WINDOW_MS,
    paneDiffMs,
    includeQueue: false,
    includePaneAnimation: true,
    includeUsage: projectPath !== null,
  });
  // Best-effort like the usage/apiMode reads below; default to "claude" (matching
  // the persisted-map default) if the live/resolved kind probe fails.
  const kind = activity.kind ?? ("claude" as AgentKind);

  const apiMode = (await deps.configResolver.resolveApiInfo?.(session).catch(() => null))?.mode;

  // Best-effort autopilot state: wrap in try/catch so a store read failure
  // degrades to no autopilot field rather than sinking the whole row.
  let autopilot: SessionRow["autopilot"];
  try {
    const ap = autopilotStore.get(session);
    if (ap.enabled) {
      autopilot = { enabled: true, pureKeepAlive: ap.pureKeepAlive, iterations: ap.iterations };
    }
  } catch {
    // degraded: leave autopilot undefined
  }

  return {
    session,
    label,
    sessionKind,
    workspacePath: projectPath,
    independentSlot,
    group: groupBinding ? { chatId: groupBinding.chatId, label: groupBinding.binding.label } : null,
    kind,
    running: activity.running,
    busy: activity.busy,
    ...(activity.taskMs !== undefined && { taskMs: activity.taskMs }),
    ...(activity.task && { task: activity.task }),
    cumulativeBusyMs: activity.cumulativeBusyMs,
    uptimeMs,
    usage: activity.usage,
    ...(apiMode !== undefined && { apiMode }),
    ...(autopilot && { autopilot }),
    ...(operatorFlag && { operator: true }),
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
    // raw (not listUserProjectSessions): the dashboard intentionally shows the operator, flagged operator:true
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
      sessionCount: rows.filter((r) => !r.operator).length,
      runningCount: rows.filter((r) => r.running && !r.operator).length,
      busyCount: rows.filter((r) => r.busy && !r.operator).length,
      queueDepth: deps.queue.size(),
      adapters: {
        telegram: Boolean(deps.config.telegramBotToken),
        lark: Boolean(deps.config.lark),
      },
      autopilotCount: rows.filter((r) => r.autopilot).length,
    },
    generatedAt: now,
  };
}
