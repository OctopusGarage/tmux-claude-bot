import { JsonMapStore } from "../infra/json-map-store.js";

/**
 * Per-tmux-session "last observed live session id" — the transcript/rollout id
 * the live agent pid was last seen holding open (via `resolveLiveTranscript`,
 * i.e. lsof on the running pid). It is refreshed on every live observation, so a
 * manual desktop session switch self-heals it to the new id within one bot
 * interaction (mirrors how {@link agentKindMap} self-heals the kind).
 *
 * It is used ONLY as a resume fallback for `/restart`: normally the restart path
 * reads the EXACT live id right before exiting the agent, but when that id can't
 * be read at that instant (claude idle, not holding the transcript open) the
 * fallback would otherwise be `--continue`/`resume --last` = "the newest session
 * in the dir", which picks the WRONG conversation when several Free Projects
 * share one cwd. The last-observed id disambiguates them, and is persisted so it
 * survives a bot restart.
 */
const store = new JsonMapStore<string>("session_live_id_map.json");

/** Record the live session id observed for a tmux session. No-op when unchanged
 * (avoids a disk write on every /history//status that re-observes the same id). */
export function recordLiveSessionId(session: string, sessionId: string): void {
  if (store.get(session) !== sessionId) store.set(session, sessionId);
}

/** The last observed live session id for a tmux session, or null. */
export function getLastLiveSessionId(session: string): string | null {
  return store.get(session) ?? null;
}

/** Drop the record (e.g. when the session/project is removed). */
export function clearLiveSessionId(session: string): void {
  store.delete(session);
}
