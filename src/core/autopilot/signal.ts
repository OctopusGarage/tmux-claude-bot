import { createLogger } from "../../shared/utils/logger.js";
import { resolveAgentKind } from "../agents/agentKindMap.js";
import { profileFor } from "../agents/registry.js";
import type { HandlerDeps } from "../deps.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { paneIsAnimating } from "../session/pane-activity.js";
import { extractSentinels } from "./goals/sentinels.js";
import { paneSemantics } from "./pane-matchers.js";
import type { AutopilotState, SessionSignal } from "./types.js";

const log = createLogger("autopilot.signal");
const ACTIVITY_WINDOW_MS = 60_000;

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
  const activityAt =
    probes?.lastActivityAt ??
    (async (s: string): Promise<number | null> => {
      const kind = await resolveAgentKind(deps.configResolver, s).catch(() => "claude" as const);
      const projectPath = getPathBySession(s);
      if (!projectPath) return null;
      const profile = profileFor(kind);
      return profile.lastActivityAt?.(deps.configResolver, s, projectPath) ?? null;
    });

  const queueEmpty = deps.queue.size(session) === 0 && !deps.queue.isSessionProcessing(session);
  const lastActivity = await activityAt(session).catch(() => null);
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
    try {
      const kind = await resolveAgentKind(deps.configResolver, session).catch(
        () => "claude" as const,
      );
      const projectPath = getPathBySession(session);
      if (projectPath) {
        const rounds = await profileFor(kind)
          .getRecentConversations(deps.configResolver, session, projectPath)
          .catch(() => []);
        roundText = rounds[0]?.assistant ?? "";
      }
    } catch (err) {
      log.debug("transcript read failed; no sentinels this tick", { session, err });
    }
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
