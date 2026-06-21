import { JsonMapStore } from "../infra/json-map-store.js";

/**
 * Per-tmux-session "exact start command" — the launch command actually used to
 * start the agent (e.g. `CLAUDE_CONFIG_DIR=~/.claude-stella claude …`), recorded
 * at start so a later recovery relaunches the SAME flavor, not the primary
 * default. {@link agentKindMap} records claude-vs-codex; this records WHICH of
 * the configured start commands, which the kind alone can't disambiguate.
 *
 * Used by reboot recovery (`recoverProjects`): after a machine restart every tmux
 * session is gone, and the kind + path + this command + the recorded session id
 * are what's needed to recreate each project exactly as it was.
 */
const store = new JsonMapStore<string>("session_start_command_map.json");

/** The exact start command recorded for a session, or null if none recorded. */
export function getStartCommand(sessionName: string): string | null {
  return store.get(sessionName) ?? null;
}

/** Record the exact start command used for a session. No-op when unchanged. */
export function setStartCommand(sessionName: string, command: string): void {
  if (store.get(sessionName) !== command) store.set(sessionName, command);
}

/** Drop the record (e.g. when the session/project is removed, so a reused free
 * slot can't read a stale command). */
export function clearStartCommand(sessionName: string): void {
  store.delete(sessionName);
}
