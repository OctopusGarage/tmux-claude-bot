import { createLogger } from "../../shared/utils/logger.js";
import { readAgentActivitySnapshot } from "../agents/activity-snapshot.js";
import { markSessionUsed, sessionLastUsedAt } from "../agents/runningSessions.js";
import type { HandlerDeps } from "../deps.js";
import { listUserProjectSessions } from "../projects/operator.js";
import { getPathBySession } from "../projects/sessionPathMap.js";

const log = createLogger("recovery.idle-reaper");

export type SessionIdleReaperSummary = {
  checked: number;
  closed: number;
  skipped: Record<string, number>;
  failures: number;
};

export async function runSessionIdleReaper(
  deps: HandlerDeps,
  input: { now?: number; maxIdleMs: number },
): Promise<SessionIdleReaperSummary> {
  const now = input.now ?? Date.now();
  const currentSessions = new Set(await deps.currentProject.allCurrent().catch(() => []));
  const summary: SessionIdleReaperSummary = {
    checked: 0,
    closed: 0,
    skipped: {},
    failures: 0,
  };

  let sessions: string[];
  try {
    sessions = await listUserProjectSessions(deps);
  } catch (err) {
    log.warn("idle reaper: could not list sessions", { err });
    return { ...summary, failures: 1 };
  }

  for (const session of sessions) {
    summary.checked++;
    try {
      const decision = await idleReaperDecision(
        deps,
        session,
        currentSessions,
        now,
        input.maxIdleMs,
      );
      if (decision.kind === "skip") {
        increment(summary.skipped, decision.reason);
        continue;
      }
      await deps.agent.exit(session);
      summary.closed++;
      log.info("idle reaper closed unused agent", {
        session,
        data: {
          idleMs: decision.idleMs,
          lastUsedAt: new Date(decision.lastUsedAt).toISOString(),
        },
      });
    } catch (err) {
      summary.failures++;
      log.warn("idle reaper: session check failed", { session, err });
    }
  }

  log.info("idle reaper sweep complete", { data: summary });
  return summary;
}

type IdleReaperDecision =
  | { kind: "close"; lastUsedAt: number; idleMs: number }
  | {
      kind: "skip";
      reason:
        | "current"
        | "queue-busy"
        | "not-running"
        | "busy"
        | "path-drifted"
        | "unknown-last-used"
        | "not-idle-long-enough";
    };

async function idleReaperDecision(
  deps: HandlerDeps,
  session: string,
  currentSessions: Set<string>,
  now: number,
  maxIdleMs: number,
): Promise<IdleReaperDecision> {
  if (currentSessions.has(session)) return { kind: "skip", reason: "current" };
  if (deps.queue.size(session) > 0 || deps.queue.isSessionProcessing(session)) {
    return { kind: "skip", reason: "queue-busy" };
  }

  const path = getPathBySession(session);
  const activity = await readAgentActivitySnapshot(deps, session, {
    now,
    ...(path !== null ? { boundPath: path } : {}),
    includeCurrentTurn: false,
    includeQueue: true,
    includeTranscript: true,
    includePaneAnimation: true,
    includePathDrift: true,
    agentRunningMode: "agent-runner",
    pathDriftFailure: "ignore",
  });

  if (!activity.running) return { kind: "skip", reason: "not-running" };
  if (activity.busy) {
    markSessionUsed(session, now);
    return { kind: "skip", reason: "busy" };
  }
  if (activity.pathDrifted) return { kind: "skip", reason: "path-drifted" };

  const lastUsedAt = latestKnownUse(session, activity.transcriptLastActivityAt);
  if (lastUsedAt === null) {
    markSessionUsed(session, now);
    return { kind: "skip", reason: "unknown-last-used" };
  }

  const idleMs = now - lastUsedAt;
  return idleMs >= maxIdleMs
    ? { kind: "close", lastUsedAt, idleMs }
    : { kind: "skip", reason: "not-idle-long-enough" };
}

export function startSessionIdleReaper(
  deps: HandlerDeps,
  config: { tickMs: number; maxIdleMs: number },
): () => void {
  if (config.tickMs <= 0 || config.maxIdleMs <= 0) {
    log.info("idle reaper disabled", { data: config });
    return () => {};
  }
  log.info("idle reaper enabled", { data: config });
  const run = (): void => {
    void runSessionIdleReaper(deps, { maxIdleMs: config.maxIdleMs }).catch((err) =>
      log.warn("idle reaper sweep failed", { err }),
    );
  };
  const initial = setTimeout(run, Math.min(config.tickMs, 60_000));
  const timer = setInterval(run, config.tickMs);
  (initial as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function latestKnownUse(session: string, transcriptLastActivityAt: number | null): number | null {
  const recorded = sessionLastUsedAt(session);
  if (transcriptLastActivityAt === null) return recorded;
  const latest =
    recorded === null ? transcriptLastActivityAt : Math.max(recorded, transcriptLastActivityAt);
  if (recorded === null || latest > recorded) markSessionUsed(session, latest);
  return latest;
}
