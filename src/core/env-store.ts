import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { serializeEnv } from "./onboarding.js";
import { appStateFile } from "../shared/state-dir.js";

const envPath = (): string => appStateFile(".env");

/**
 * Persist a single var into `.env` so a runtime preference (voice language, UI
 * language, …) survives a restart — the running process already has it via
 * process.env; this is for next boot. No-op when there is no `.env` to write
 * into. Uses the existing file as the template: serializeEnv replaces only that
 * one line (or appends it) and leaves every other line untouched. Atomic + 0600.
 */
export function persistEnvVar(key: string, value: string): void {
  const path = envPath();
  if (!existsSync(path)) return;
  const current = readFileSync(path, "utf8");
  const next = serializeEnv(current, { [key]: value });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, next, "utf8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
