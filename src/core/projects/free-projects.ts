import { basename } from "node:path";
import { UI_ICONS } from "../../shared/ui/icons.js";
import { JsonMapStore } from "../infra/json-map-store.js";

/** Hard cap on concurrent independent sessions (legacy free slots 1..N). */
export const FREE_PROJECT_LIMIT = 10;

const FREE_INFIX = "free_";

/** Registry row for one independent-session slot. The directory (when it has one)
 * lives in session_path_map.json keyed by the session name, the single source of
 * truth — so only the user-given label is stored here. */
export interface FreeProjectEntry {
  label: string | null;
}

const store = new JsonMapStore<FreeProjectEntry>("free_projects.json");

/** `tmux_proj_` + slot → `tmux_proj_free_3`. Reuses the project prefix so the
 * session shows up in listProjectSessions() / switch / group-binding unchanged. */
export function freeSessionName(prefix: string, slot: number): string {
  return `${prefix}${FREE_INFIX}${slot}`;
}

/** The slot number if `session` is an independent session under `prefix`, else null.
 * Requires the WHOLE post-prefix remainder to be `free_<digits>`, so a path-
 * derived session that merely contains "free_1" does not match. */
export function freeSlotOf(session: string, prefix: string): number | null {
  if (!session.startsWith(prefix)) return null;
  const m = session.slice(prefix.length).match(/^free_(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Used slot numbers, ascending (numeric, not the store's lexicographic order). */
export function listFreeSlots(): number[] {
  return store
    .sortedEntries()
    .map(([k]) => Number(k))
    .sort((a, b) => a - b);
}

/** Lowest unused slot in 1..LIMIT, or null when full. */
export function allocateFreeSlot(): number | null {
  const used = new Set(listFreeSlots());
  for (let n = 1; n <= FREE_PROJECT_LIMIT; n++) if (!used.has(n)) return n;
  return null;
}

/** `null` = no such slot; `{ label: null }` = slot exists but was left unnamed.
 * The object (rather than a bare `string | null`) keeps those two cases distinct. */
export function getFreeProject(slot: number): FreeProjectEntry | null {
  return store.get(String(slot)) ?? null;
}

export function setFreeProject(slot: number, entry: FreeProjectEntry): void {
  store.set(String(slot), entry);
}

export function releaseFreeSlot(slot: number): boolean {
  return store.delete(String(slot));
}

/**
 * List label for an independent session:
 * `<independent icon> <label|Independent #n>[ · <basename>]`.
 *
 * Deliberately surfaced only by LIST views (aliveProjectButtons). Reply/queue
 * headers keep the plain `projectLabel` — which already shows the directory
 * basename once the user has `cd`'d — rather than thread the configurable session
 * prefix (needed to detect an independent session) into those low-level formatters. The
 * coupling cost outweighs an emoji on a transient bare-session state.
 */
export function freeLabel(
  slot: number,
  entry: FreeProjectEntry | null,
  path: string | null,
): string {
  const name = entry?.label ?? `Independent #${slot}`;
  const base = path ? basename(path.replace(/\/+$/, "")) : null;
  return base
    ? `${UI_ICONS.session.independent} ${name} · ${base}`
    : `${UI_ICONS.session.independent} ${name}`;
}
