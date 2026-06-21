import { createLogger } from "../../shared/utils/logger.js";
import { JsonMapStore } from "../infra/json-map-store.js";
import type { ConfigResolver } from "./agent-config-resolver.js"; // type-only — no cycle
import type { AgentKind } from "./types.js";

const log = createLogger("agents.kind");

/** Persisted map of tmux session name → which agent it runs. A session absent
 * from the map predates codex support (or is a claude session) → defaults to
 * "claude", so existing installs and orphans behave exactly as before. */
const store = new JsonMapStore<AgentKind>("session_agent_map.json");

export function getAgentKind(sessionName: string): AgentKind {
  return store.get(sessionName) ?? "claude";
}

export function setAgentKind(sessionName: string, kind: AgentKind): void {
  store.set(sessionName, kind);
}

/** Drop the record (e.g. when the session/project is removed, so a reused free
 * slot can't read a stale kind and reboot recovery sees an accurate roster). */
export function clearAgentKind(sessionName: string): void {
  store.delete(sessionName);
}

/** The agent running in `session`: the LIVE process when one is detectable,
 * else the recorded launch-intent (set at start), else "claude". Live process
 * wins so a running session always reflects reality, not a stale record.
 *
 * Self-healing: a manual desktop switch (user quits codex and starts claude in
 * the pane) fires no bot hook, so the persisted intent would otherwise go stale
 * and the post-stop fallback — and `/restart`'s resume command — would name the
 * pre-switch kind. Whenever live detection disagrees with the stored kind we
 * write the live value through, so once the session stops the fallback reports
 * what was actually running last. (Absent sessions already default to "claude",
 * so a running claude leaves the map untouched — no default pollution.) */
export async function resolveAgentKind(
  resolver: Pick<ConfigResolver, "detectAgentKind">,
  session: string,
): Promise<AgentKind> {
  const live = await resolver.detectAgentKind?.(session);
  if (live == null) return getAgentKind(session);
  const stored = getAgentKind(session);
  if (stored !== live) {
    setAgentKind(session, live);
    log.info("self-healed kind", { session, data: { from: stored, to: live } });
  }
  return live;
}
