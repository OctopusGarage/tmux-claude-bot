import * as fs from "node:fs";
import { stateFile } from "./state-dir.js";

const marker = (): string => stateFile(process.cwd(), ".running");

/**
 * Crash detection via a liveness marker. A clean shutdown (SIGINT/SIGTERM) removes
 * the marker; if it is still present at startup, the previous run exited uncleanly
 * — a crash (uncaughtException → exit 1), SIGKILL, OOM, or power loss. Rewrites the
 * marker for this run and returns whether the previous one was unclean, so the bot
 * can alert its owner that launchd auto-recovered it. Without this, KeepAlive
 * restarts are silent and a crash-loop goes unnoticed.
 */
export function detectUncleanRestart(): boolean {
  const path = marker();
  let unclean = false;
  try {
    unclean = fs.existsSync(path);
  } catch {
    /* unreadable → treat as clean */
  }
  try {
    fs.writeFileSync(path, `${process.pid} ${new Date().toISOString()}\n`, "utf8");
  } catch {
    /* best-effort; missing marker just means the next crash won't be flagged */
  }
  return unclean;
}

/** Remove the liveness marker so the next startup is not flagged as a crash. */
export function markCleanShutdown(): void {
  try {
    fs.rmSync(marker(), { force: true });
  } catch {
    /* best-effort */
  }
}
