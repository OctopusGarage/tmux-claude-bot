import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("platform.keep-awake");

export type KeepAwakeController = {
  acquire(): boolean;
  release(): void;
  active(): boolean;
  stop(): void;
};

type KeepAwakeControllerOptions = {
  platform?: string;
  pid?: number;
  spawnChild?: typeof spawn;
};

/**
 * Hold one process-bound macOS sleep assertion while the controller is acquired.
 * Spawns
 * `caffeinate -s -w <our pid>`:
 *  - `-s` pins system sleep while on AC (so it doesn't drain on battery),
 *  - `-w <pid>` binds the assertion to THIS process, so caffeinate self-exits if we
 *    crash without a clean shutdown — no orphaned assertion.
 *
 * Lives in the bot process (not the launchd wrapper) so it covers every launch path
 * and can be released during scheduled quiet hours without changing macOS policy.
 * Does NOT cover lid-closed (clamshell) sleep; that needs `sudo pmset -a disablesleep 1`.
 */
export function createKeepAwakeController(
  options: KeepAwakeControllerOptions = {},
): KeepAwakeController {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const spawnChild = options.spawnChild ?? spawn;
  let proc: ChildProcess | null = null;

  const release = (): void => {
    if (!proc) return;
    const child = proc;
    proc = null;
    child.kill("SIGTERM");
    log.info("keep-awake released; macOS may sleep naturally");
  };

  return {
    acquire(): boolean {
      if (platform !== "darwin") return false;
      if (proc) return true;
      try {
        const child = spawnChild("caffeinate", ["-s", "-w", String(pid)], {
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
        log.info("keep-awake acquired (caffeinate -s; AC power only)");
        return true;
      } catch (err) {
        log.warn("keep-awake spawn threw", { err });
        proc = null;
        return false;
      }
    },
    release,
    active: () => proc !== null,
    stop: release,
  };
}

let defaultController: KeepAwakeController | undefined;

/** Backward-compatible one-shot API; scheduled mode uses the controller directly. */
export function startKeepAwake(enabled: boolean): void {
  if (!enabled) return;
  defaultController ??= createKeepAwakeController();
  defaultController.acquire();
}

/** End the keep-awake assertion on graceful shutdown (the `-w` guard is the
 * crash-safety net; this makes a clean stop deterministic). */
export function stopKeepAwake(): void {
  defaultController?.stop();
  defaultController = undefined;
}
