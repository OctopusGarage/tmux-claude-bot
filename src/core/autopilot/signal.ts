import { createLogger } from "../../shared/utils/logger.js";
import type { HandlerDeps } from "../deps.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { paneIsAnimating } from "../session/pane-activity.js";
import { readSessionTelemetry, SESSION_ACTIVITY_WINDOW_MS } from "../session/session-telemetry.js";
import { extractSentinels } from "./goals/sentinels.js";
import { paneSemantics } from "./pane-matchers.js";
import type { AutopilotState, SessionSignal } from "./types.js";

const log = createLogger("autopilot.signal");
const ACTIVITY_WINDOW_MS = SESSION_ACTIVITY_WINDOW_MS;

type Probes = {
  paneIsAnimating: (session: string) => Promise<boolean>;
  lastActivityAt: (session: string) => Promise<number | null>;
  recentAssistant?: (session: string) => Promise<string>; // the agent's latest assistant turn (sentinel source)
};

export async function observeSignal(
  deps: HandlerDeps,
  session: string,
  state: AutopilotState,
  now: number,
  probes?: Probes,
): Promise<SessionSignal> {
  const animate = probes?.paneIsAnimating ?? ((s: string) => paneIsAnimating(deps.bridge, s));
  const telemetry =
    probes === undefined
      ? await readSessionTelemetry(deps, session, {
          boundPath: getPathBySession(session),
          now,
          activityWindowMs: ACTIVITY_WINDOW_MS,
          includeQueue: false,
          includeLatestAssistant: true,
        })
      : null;

  const queueEmpty = queueIsEmpty(deps, session);
  const lastActivity =
    probes !== undefined
      ? await probes.lastActivityAt(session).catch(() => null)
      : (telemetry?.transcriptLastActivityAt ?? null);
  const liveActive = lastActivity !== null && now - lastActivity < ACTIVITY_WINDOW_MS;
  const animating = queueEmpty && !liveActive ? await animate(session).catch(() => false) : false;
  const busy = !queueEmpty || liveActive || animating;

  const lastSeen = Math.max(lastActivity ?? 0, state.lastNudgeAt ?? 0);
  const idleForMs = lastSeen === 0 ? Number.POSITIVE_INFINITY : now - lastSeen;

  // A degraded probe (tmux/transcript read failing) must be visible at DEBUG: an
  // empty pane / no sentinels then looks identical to a genuinely-idle agent, which
  // is the hardest "why did autopilot stall?" case to diagnose during testing.
  const paneText = await deps.bridge.capturePane(session).catch((err) => {
    log.debug("pane capture failed; treating pane as empty", { session, err });
    return "";
  });

  let roundText = "";
  if (probes?.recentAssistant) {
    roundText = await probes.recentAssistant(session).catch(() => "");
  } else {
    roundText = telemetry?.latestAssistant ?? "";
  }
  // Extract completion markers from the AGENT'S latest turn only — NOT the pane.
  // The pane echoes the bot's own injected prompts, which contain the literal
  // markers (e.g. "reply [TASK_DONE] when done", "output [GOAL_DONE]"), so reading
  // the pane would let the bot's own instruction self-satisfy a completion sentinel.
  const sentinels = extractSentinels(roundText);

  return {
    session,
    busy,
    idleForMs,
    queueEmpty,
    // Conservatively false: an idle agent is treated as "unfinished" and gets a
    // keep-alive nudge. Reliable transcript-based finish detection is hard (a
    // genuinely-done agent looks identical to one stopped mid-task), so rather
    // than a flaky heuristic we rely on the governor's progress-aware loop
    // detection to STOP nudging once the agent stops responding (same `progressAt`
    // digest twice ⇒ stop) — bounding the "nudge a finished agent" case.
    turnFinished: false,
    pane: paneSemantics(paneText),
    progressAt: lastActivity ?? 0,
    sentinels,
  };
}

function queueIsEmpty(deps: HandlerDeps, session: string): boolean {
  const queue = deps.queue as Partial<HandlerDeps["queue"]>;
  return (
    (queue.size?.(session) ?? 0) === 0 &&
    queue.isSessionProcessing?.(session) !== true &&
    (queue.getSessionQueue?.(session).length ?? 0) === 0
  );
}
