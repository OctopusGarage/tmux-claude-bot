import { persistEnvVar } from "../infra/env-store.js";

const KEY = "AUTOPILOT_GLOBAL_KEEPALIVE";

/** Global keep-alive: when on, the manager auto-enrolls pristine (never-managed,
 * not opted-out, no goal) live sessions into keep-alive autopilot, so the user
 * doesn't have to `/autopilot on` each project. Read LIVE from process.env (not
 * the boot-cached config) so a runtime `/autopilot global on` takes effect at
 * once; persisted to .env so it survives a restart. Mirrors `setUiLang`. */
export function isGlobalKeepAlive(): boolean {
  const v = process.env[KEY];
  return v === "1" || v === "true";
}

export function setGlobalKeepAlive(on: boolean): void {
  const v = on ? "1" : "0";
  process.env[KEY] = v;
  persistEnvVar(KEY, v);
}
