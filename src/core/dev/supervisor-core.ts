/** Pure decision logic for the dev supervisor. No I/O — unit-testable. */

const RELOAD_EXT_RE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE_RE = /\.test\.(ts|tsx|mts|cts)$/;

/** A change should hot-reload the bot only for source files we actually run.
 * Test files and non-TS files don't affect the running bot. */
export function shouldTriggerReload(relPath: string): boolean {
  if (!RELOAD_EXT_RE.test(relPath)) return false;
  if (TEST_FILE_RE.test(relPath)) return false;
  if (relPath.includes("__tests__")) return false;
  return true;
}

export type GateResult = "reload" | "hold";

/** After a typecheck, decide whether to hot-reload the child. */
export function decideGate(tscExitCode: number): GateResult {
  return tscExitCode === 0 ? "reload" : "hold";
}

export interface BackoffConfig {
  windowMs: number;
  maxInWindow: number;
  delayMs: number;
}

export type CrashAction = { action: "respawn"; delayMs: number } | { action: "wait" };

/** Given recent crash timestamps and now, decide respawn vs give up. Prevents a
 * crash-loop when an edit passes tsc but throws at boot. */
export function nextCrashAction(
  recentCrashesMs: number[],
  nowMs: number,
  cfg: BackoffConfig,
): CrashAction {
  const inWindow = recentCrashesMs.filter((t) => nowMs - t < cfg.windowMs);
  if (inWindow.length >= cfg.maxInWindow) return { action: "wait" };
  return { action: "respawn", delayMs: cfg.delayMs };
}

export interface SupervisorStatus {
  state: "running" | "typecheck-failed" | "crash-wait" | "reload-deferred";
  lastReloadAtMs: number | null;
  lastError: string | null;
  updatedAtMs: number;
}

export function buildStatus(
  partial: Omit<SupervisorStatus, "updatedAtMs">,
  nowMs: number,
): SupervisorStatus {
  return { ...partial, updatedAtMs: nowMs };
}
