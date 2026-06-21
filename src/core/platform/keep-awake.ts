import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("platform.keep-awake");

let proc: ChildProcess | null = null;

/**
 * Keep the Mac awake for the bot's lifetime (macOS only, opt-in via config). Spawns
 * `caffeinate -i -s -w <our pid>`:
 *  - `-i` blocks idle system sleep (keeps the bot reachable from the phone),
 *  - `-s` pins full system sleep while on AC (so it doesn't drain on battery),
 *  - `-w <pid>` binds the assertion to THIS process, so caffeinate self-exits if we
 *    crash without a clean shutdown — no orphaned assertion.
 *
 * Lives in the bot process (not the launchd wrapper) so it covers EVERY launch path
 * — `npm run dev` (tsx), the managed launchd service, and a manual run — identically.
 * Does NOT cover lid-closed (clamshell) sleep; that needs `sudo pmset -a disablesleep 1`.
 */
export function startKeepAwake(enabled: boolean): void {
  if (!enabled || process.platform !== "darwin" || proc) return;
  try {
    const child = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], {
      stdio: "ignore",
    });
    child.on("error", (err) => {
      log.warn("caffeinate failed to start", { err });
      if (proc === child) proc = null;
    });
    child.on("exit", () => {
      if (proc === child) proc = null;
    });
    proc = child;
    log.info("keep-awake enabled (caffeinate -i -s)");
  } catch (err) {
    log.warn("keep-awake spawn threw", { err });
    proc = null;
  }
}

/** End the keep-awake assertion on graceful shutdown (the `-w` guard is the
 * crash-safety net; this makes a clean stop deterministic). */
export function stopKeepAwake(): void {
  if (!proc) return;
  proc.kill("SIGTERM");
  proc = null;
}
