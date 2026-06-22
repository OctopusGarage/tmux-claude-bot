import type { HandlerDeps } from "../deps.js";
import { projectLabel } from "../projects/project-label.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { AutopilotStore } from "./state-store.js";

export type AutopilotSnapshot = {
  sessions: Array<{
    session: string;
    label: string;
    enabled: boolean;
    pureKeepAlive: boolean;
    iterations: number;
    goalId?: string;
    phaseIndex?: number;
  }>;
  generatedAt: number;
};

/**
 * Gather a snapshot of autopilot state across all sessions.
 * Sources: live sessions (deps.bridge.listProjectSessions()) UNION recorded
 * enabled sessions (AutopilotStore.enabledSessions()) — per the Resilience
 * Protocol, the live set may include desktop-created sessions the bot never
 * saw, while the recorded set may include sessions whose tmux pane is gone.
 * A listProjectSessions failure degrades gracefully to the recorded set only.
 */
export async function buildAutopilotSnapshot(deps: HandlerDeps): Promise<AutopilotSnapshot> {
  const store = new AutopilotStore();

  let liveSessions: string[] = [];
  try {
    liveSessions = await deps.bridge.listProjectSessions();
  } catch {
    // degraded: fall back to the recorded enabled set only
  }

  const recordedEnabled = store.enabledSessions();

  // Dedupe: live ∪ records, sorted for stable output.
  const all = [...new Set([...liveSessions, ...recordedEnabled])].sort();

  const sessions = all.map((session) => {
    const ap = store.get(session);
    const label = projectLabel(session, getPathBySession(session) ?? undefined);
    return {
      session,
      label,
      enabled: ap.enabled,
      pureKeepAlive: ap.pureKeepAlive,
      iterations: ap.iterations,
      ...(ap.goalId !== undefined && { goalId: ap.goalId, phaseIndex: ap.phaseIndex ?? 0 }),
    };
  });

  return { sessions, generatedAt: Date.now() };
}

/** Concise text listing of autopilot state across all sessions. */
export function formatAutopilotText(snap: AutopilotSnapshot): string {
  const enabledCount = snap.sessions.filter((s) => s.enabled).length;
  const header = `✈️ autopilot · ${enabledCount} enabled / ${snap.sessions.length} sessions`;
  if (snap.sessions.length === 0) return header;
  const lines = snap.sessions.map((s) => {
    const dot = s.enabled ? "🟢" : "⚪";
    const mode = s.pureKeepAlive ? "keep-alive" : "goal-driven";
    const goalMarker = s.goalId !== undefined ? ` · 🎯 ${s.goalId}#${s.phaseIndex}` : "";
    return `${dot} ${s.label} · ${mode} · ${s.iterations} interventions${goalMarker}`;
  });
  return `${header}\n${lines.join("\n")}`;
}
