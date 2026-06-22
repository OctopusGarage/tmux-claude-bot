import { JsonMapStore } from "../infra/json-map-store.js";
import { type AutopilotState, defaultState } from "./types.js";

/** Per-session autopilot state, persisted under the state dir and restored on
 * boot (losing it would silently stop autopilot or confuse the user). */
export class AutopilotStore {
  private readonly store = new JsonMapStore<AutopilotState>("autopilot_state.json");

  get(session: string): AutopilotState {
    return this.store.get(session) ?? defaultState();
  }

  set(session: string, state: AutopilotState): void {
    this.store.set(session, state);
  }

  enabledSessions(): string[] {
    return this.store
      .sortedEntries()
      .filter(([, s]) => s.enabled)
      .map(([name]) => name);
  }

  clear(session: string): void {
    this.store.delete(session);
  }
}

/** Drop a session's autopilot record on project removal, so a reused free slot
 * (e.g. tmux_proj_free_N) can't read stale state — optOut/goalId/viaGlobal would
 * otherwise carry over. Mirrors clearAgentKind / clearTaskTiming in the removal
 * path. The sweep only self-heals ENABLED records; an opted-out/stopped record
 * lingers without this. */
export function clearAutopilotState(session: string): void {
  new AutopilotStore().clear(session);
}
