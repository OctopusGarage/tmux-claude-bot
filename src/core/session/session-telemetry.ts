import * as fs from "node:fs";
import type { AgentKind } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { resolveAgentKind } from "../agents/agentKindMap.js";
import { profileFor } from "../agents/registry.js";
import type { HandlerDeps } from "../deps.js";
import type { UsageSnapshot } from "../read/usage.js";
import { PANE_DIFF_MS, paneIsAnimating } from "./pane-activity.js";

const log = createLogger("session.telemetry");

/** Short activity window for compact project/session lists. */
export const SHORT_ACTIVITY_WINDOW_MS = 8_000;

/** Dashboard/autopilot window: generous enough to bridge streamed-write gaps. */
export const SESSION_ACTIVITY_WINDOW_MS = 60_000;

export type SessionTelemetry = {
  /** Live agent kind when detectable, else the recorded launch intent. */
  agentKind: AgentKind | null;
  /** Whether an agent process appears to be running in this project session. */
  agentRunning: boolean;
  /** Pending or in-flight bot work for this project session. */
  queueBusy: boolean;
  /** Newest transcript write time for this project session, when resolvable. */
  transcriptLastActivityAt: number | null;
  /** Whether the transcript activity is within the requested activity window. */
  transcriptBusy: boolean;
  /** Whether the pane changed across the animation diff probe. */
  paneAnimating: boolean;
  /** Unified busy signal from the enabled probes. */
  busy: boolean;
  /** Whether the live pane cwd has drifted from the bound workspace path. */
  pathDrifted: boolean;
  /** Current agent usage snapshot when requested and available. */
  usage: UsageSnapshot | null;
  /** Newest assistant turn when requested and available. */
  latestAssistant: string;
  /** Raw epoch ms of the newest round, useful for desktop-driven duration. */
  currentTurnStartedAt: number | null;
};

export type SessionTelemetryOptions = {
  boundPath?: string | null;
  now?: number;
  activityWindowMs?: number;
  paneDiffMs?: number;
  includeQueue?: boolean;
  includeTranscript?: boolean;
  includePaneAnimation?: boolean;
  includePathDrift?: boolean;
  includeUsage?: boolean;
  includeLatestAssistant?: boolean;
  includeCurrentTurn?: boolean;
  agentKindMode?: "resolved" | "live";
  agentRunningMode?: "agent-runner" | "live-kind";
  pathDriftFailure?: "ignore" | "throw";
};

/**
 * Deep read model for project-session telemetry. Callers get one stable shape
 * instead of re-learning how to combine process detection, queue state,
 * transcript mtime, pane animation, cwd drift, usage, and recent assistant text.
 */
export async function readSessionTelemetry(
  deps: HandlerDeps,
  session: string,
  opts: SessionTelemetryOptions = {},
): Promise<SessionTelemetry> {
  const now = opts.now ?? Date.now();
  const activityWindowMs = opts.activityWindowMs ?? SESSION_ACTIVITY_WINDOW_MS;
  const projectPath = opts.boundPath ?? null;
  const includeQueue = opts.includeQueue ?? true;
  const includeTranscript = opts.includeTranscript ?? true;
  const includePaneAnimation = opts.includePaneAnimation ?? false;
  const includePathDrift = opts.includePathDrift ?? false;
  const includeUsage = opts.includeUsage ?? false;
  const includeRecent = opts.includeLatestAssistant === true || opts.includeCurrentTurn === true;

  const liveAgentKind = deps.configResolver.detectAgentKind?.(session).catch((err) => {
    log.debug("live agent kind read failed", { session, err });
    return null;
  });
  const [detectedAgentKind, resolvedAgentKind, agentRunnerRunning, queueBusy] = await Promise.all([
    liveAgentKind ?? Promise.resolve(null),
    opts.agentKindMode === "live"
      ? Promise.resolve(null)
      : resolveAgentKind(deps.configResolver, session).catch((err) => {
          log.debug("resolved agent kind read failed", { session, err });
          return null;
        }),
    opts.agentRunningMode === "live-kind"
      ? Promise.resolve(false)
      : checkAgentRunning(deps, session),
    Promise.resolve(includeQueue ? isQueueBusy(deps, session) : false),
  ]);
  const agentKind = opts.agentKindMode === "live" ? detectedAgentKind : resolvedAgentKind;
  const agentRunning =
    opts.agentRunningMode === "live-kind" ? detectedAgentKind !== null : agentRunnerRunning;

  const profile = agentKind ? profileFor(agentKind) : null;
  const canReadTranscript = includeTranscript && profile !== null && projectPath !== null;
  const [rawTranscriptLastActivityAt, transcriptPath, usage, recent] = await Promise.all([
    canReadTranscript
      ? (profile.lastActivityAt?.(deps.configResolver, session, projectPath).catch((err) => {
          log.debug("transcript activity read failed", { session, err });
          return null;
        }) ?? Promise.resolve(null))
      : Promise.resolve(null),
    canReadTranscript
      ? (profile.resolveTranscriptPath?.(deps.configResolver, session, projectPath).catch((err) => {
          log.debug("transcript path read failed", { session, err });
          return null;
        }) ?? Promise.resolve(null))
      : Promise.resolve(null),
    includeUsage && profile !== null && projectPath !== null
      ? profile.readUsage(deps.configResolver, session, projectPath).catch((err) => {
          log.debug("usage read failed", { session, err });
          return null;
        })
      : Promise.resolve(null),
    includeRecent && profile !== null && projectPath !== null
      ? profile.getRecentConversations(deps.configResolver, session, projectPath).catch((err) => {
          log.debug("recent transcript read failed", { session, err });
          return [];
        })
      : Promise.resolve([]),
  ]);

  const eventActive = transcriptPath
    ? isTranscriptActive(deps, transcriptPath, activityWindowMs)
    : false;
  const transcriptLastActivityAt = eventActive
    ? Math.max(rawTranscriptLastActivityAt ?? 0, now)
    : rawTranscriptLastActivityAt;
  const transcriptBusy =
    eventActive ||
    (transcriptLastActivityAt !== null && now - transcriptLastActivityAt < activityWindowMs);
  let busy = queueBusy || transcriptBusy;
  let paneAnimating = false;
  if (includePaneAnimation && !busy) {
    paneAnimating = await paneIsAnimating(
      deps.bridge,
      session,
      opts.paneDiffMs ?? PANE_DIFF_MS,
    ).catch(() => false);
    busy = paneAnimating;
  }

  let actualPath: string | null = null;
  if (includePathDrift && projectPath !== null && agentRunning) {
    try {
      actualPath = await deps.bridge.paneCurrentPath(session);
    } catch (err) {
      log.debug("pane cwd read failed", { session, err });
      if (opts.pathDriftFailure === "throw") throw err;
    }
  }

  return {
    agentKind,
    agentRunning,
    queueBusy,
    transcriptLastActivityAt,
    transcriptBusy,
    paneAnimating,
    busy,
    pathDrifted: Boolean(
      actualPath && projectPath && realpathOrSelf(actualPath) !== realpathOrSelf(projectPath),
    ),
    usage,
    latestAssistant: recent[0]?.assistant ?? "",
    currentTurnStartedAt: recent[0]?.timeMs && recent[0].timeMs > 0 ? recent[0].timeMs : null,
  };
}

function isQueueBusy(deps: HandlerDeps, session: string): boolean {
  const queue = (deps as Partial<HandlerDeps>).queue as Partial<HandlerDeps["queue"]> | undefined;
  return (
    queue?.isSessionProcessing?.(session) === true ||
    (queue?.getSessionQueue?.(session).length ?? 0) > 0 ||
    (queue?.size?.(session) ?? 0) > 0
  );
}

function checkAgentRunning(deps: HandlerDeps, session: string): Promise<boolean> {
  const runner = (deps as Partial<HandlerDeps>).agent as Partial<HandlerDeps["agent"]> | undefined;
  return runner?.checkIfRunning?.(session).catch(() => false) ?? Promise.resolve(true);
}

function isTranscriptActive(
  deps: HandlerDeps,
  transcriptPath: string,
  activityWindowMs: number,
): boolean {
  const activity = deps.activity as Partial<HandlerDeps["activity"]> | undefined;
  return activity?.isActiveWithin?.(transcriptPath, activityWindowMs) ?? false;
}

/** Resolve a path through realpathSync to normalize symlinks; fall back to raw
 * string when the path no longer exists. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
