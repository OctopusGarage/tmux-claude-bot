import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appStateFile } from "../../../shared/state-dir.js";
import { createLogger } from "../../../shared/utils/logger.js";
import { parseGoal } from "./schema.js";
import type { Goal } from "./types.js";

const log = createLogger("autopilot.user-goals");

/** Where user goal presets live: AUTOPILOT_GOALS_DIR, else `<state>/autopilot-goals`. */
export function resolveGoalsDir(): string {
  return process.env.AUTOPILOT_GOALS_DIR || appStateFile("autopilot-goals");
}

/** Load + validate `*.json` goal presets from `dir`. Invalid files are skipped
 * with a log; a missing dir yields []. Never throws. */
export function loadUserGoals(dir: string): Goal[] {
  let names: string[];
  try {
    if (!existsSync(dir)) return [];
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (err) {
    log.warn("could not read goals dir", { err });
    return [];
  }
  const out: Goal[] = [];
  for (const name of names.sort()) {
    try {
      const raw = readFileSync(join(dir, name), "utf-8");
      const r = parseGoal(JSON.parse(raw));
      if (r.ok) out.push(r.goal);
      else log.warn(`skipping invalid goal ${name}: ${r.error}`);
    } catch (err) {
      log.warn(`skipping unreadable goal ${name}`, { err });
    }
  }
  return out;
}
