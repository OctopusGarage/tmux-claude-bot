import { existsSync, readFileSync } from "node:fs";
import { appStateFile } from "../shared/state-dir.js";
import { writeFileAtomicSync } from "../shared/utils/atomic-write.js";
import { serializeEnv } from "./onboarding.js";

const envPath = (): string => appStateFile(".env");

/**
 * Persist a single var into `.env` so a runtime preference (voice language, UI
 * language, …) survives a restart — the running process already has it via
 * process.env; this is for next boot. No-op when there is no `.env` to write
 * into. Uses the existing file as the template: serializeEnv replaces only that
 * one line (or appends it) and leaves every other line untouched. The write goes
 * through the shared atomic writer (temp + fsync + rename, 0600) so a crash
 * mid-write can't truncate `.env` and lose the bot token.
 */
export function persistEnvVar(key: string, value: string): void {
  const path = envPath();
  if (!existsSync(path)) return;
  const current = readFileSync(path, "utf8");
  const next = serializeEnv(current, { [key]: value });
  writeFileAtomicSync(path, next, { mode: 0o600 });
}
