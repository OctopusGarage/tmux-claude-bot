import { homedir } from "node:os";

/**
 * Expand a leading `~` (or `~/…`) to the home directory — and ONLY a leading one.
 * A bare `replaceAll("~", homedir())` corrupts legitimate paths that contain a
 * tilde mid-string (e.g. `/srv/~backup`). `~user` (other-user home) is not
 * supported and is returned unchanged.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collapse the home directory to `~` wherever it appears in user-facing TEXT, so
 * a path reads `~/projects/x`, never `/Users/alice/projects/x`. This is applied at
 * the message-send boundary (Telegram reply / Lark send), so EVERY current and
 * future user-facing path is shortened without each call site remembering to —
 * see CLAUDE.md "User-facing paths". A trailing boundary (`/`, end, whitespace,
 * quote, bracket, `:`/`,`) keeps `/Users/alice2` from matching the `alice` home.
 */
// Cache the compiled regex (keyed on the resolved home), since this runs on every
// message send and the home dir doesn't change at runtime. Re-derived only if home
// changes (e.g. tests that repoint $HOME). A `.replace()` resets lastIndex, so
// reusing the global regex is safe.
let cachedHome: string | undefined;
let cachedHomeRegex: RegExp | null = null;
function homeRegex(): RegExp | null {
  const home = homedir();
  if (home !== cachedHome) {
    cachedHome = home;
    cachedHomeRegex =
      !home || home === "/" ? null : new RegExp(`${escapeRegExp(home)}(?=/|$|[\\s"')\\]:,])`, "g");
  }
  return cachedHomeRegex;
}

export function tildeifyHome(text: string): string {
  const re = homeRegex();
  return re ? text.replace(re, "~") : text;
}

/**
 * Recursively {@link tildeifyHome} every string in a value (objects, arrays) — for
 * structured payloads like Lark cards. Returns a new value; the input is untouched.
 */
export function tildeifyHomeDeep<T>(value: T): T {
  if (typeof value === "string") return tildeifyHome(value) as T;
  if (Array.isArray(value)) return value.map((v) => tildeifyHomeDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = tildeifyHomeDeep(v);
    return out as T;
  }
  return value;
}
