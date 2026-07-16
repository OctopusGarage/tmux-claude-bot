/** Operator (home) session identity + the routing fallback. Pure, no I/O.
 * The operator is a reserved session in the `tmux_proj_` family that becomes the
 * default routing target when a chat channel has no current project. */

/** Reserved operator session name, e.g. `tmux_proj_home`. Reuses the project
 * prefix so switch/recovery/reply machinery treat it like any session. */
export function operatorSessionName(prefix: string): string {
  return `${prefix}home`;
}

/** Reserved loop supervisor session name, e.g. `tmux_proj_loop-supervisor`. */
export function loopSupervisorSessionName(prefix: string): string {
  return `${prefix}loop-supervisor`;
}

/** True iff `session` is the reserved operator session for this prefix. */
export function isOperator(session: string, prefix: string): boolean {
  return session === operatorSessionName(prefix);
}

/** True iff `session` is reserved bot infrastructure, not a user project. */
export function isReservedInfrastructureSession(session: string, prefix: string): boolean {
  return session === operatorSessionName(prefix) || session === loopSupervisorSessionName(prefix);
}

/** Resolve the target session for a channel: an explicit current project wins;
 * otherwise the operator session when enabled; otherwise null (no target).
 * A stale current pointing at the operator while it's disabled → no target
 * (fall back to "no project" rather than routing to a dead pane). */
export function resolveTargetSession(
  current: string | null,
  operatorEnabled: boolean,
  prefix: string,
): string | null {
  const op = operatorSessionName(prefix);
  // Stale /home pointer while operator is disabled → clear it.
  if (current === op && !operatorEnabled) return null;
  if (current !== null) return current;
  return operatorEnabled ? op : null;
}

/** Result of the /home command — decoupled from adapters for testability. Each
 * adapter renders its own localized message; this only carries the outcome + target. */
export type HomeCommandResult = { ok: true; session: string } | { ok: false };

/** Pure helper shared by both adapters: derive /home outcome from config. */
export function homeCommandResult(enabled: boolean, prefix: string): HomeCommandResult {
  if (!enabled) return { ok: false };
  return { ok: true, session: operatorSessionName(prefix) };
}

/** Live project sessions EXCLUDING the reserved operator — the set of real USER
 * projects. Use this (not bridge.listProjectSessions directly) for any picker /
 * roster / status that should treat the operator as infrastructure, not a project. */
export async function listUserProjectSessions(deps: {
  bridge: { listProjectSessions(): Promise<string[]> };
  config: { projectSessionPrefix: string };
}): Promise<string[]> {
  const prefix = deps.config.projectSessionPrefix;
  return (await deps.bridge.listProjectSessions()).filter(
    (s) => !isReservedInfrastructureSession(s, prefix),
  );
}
