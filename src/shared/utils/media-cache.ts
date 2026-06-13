import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { appStateFile } from "../state-dir.js";

// Media cache lives under the app state home so it follows TCB_STATE_DIR;
// TCB_MEDIA_DIR still overrides for explicit redirection / tests. Resolved on
// EVERY call (not captured at module load) so a later env change — tests, a
// dev-borrow session — always takes effect.
function cacheDir(): string {
  return process.env.TCB_MEDIA_DIR ?? appStateFile("media");
}

/** Max number of cached blobs kept before the oldest are evicted. Overridable
 *  via TCB_MEDIA_CACHE_MAX; the cache is a convenience, not a source of truth. */
const DEFAULT_MAX_ENTRIES = 1000;
function maxEntries(): number {
  const raw = Number(process.env.TCB_MEDIA_CACHE_MAX);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_ENTRIES;
}

function cachePathFor(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return nodePath.join(cacheDir(), hash);
}

/** Return the cached file path for `key`, or null if not cached. */
export function getFromCache(key: string): string | null {
  const p = cachePathFor(key);
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return p;
  } catch {
    return null;
  }
}

/**
 * Copy `sourcePath` into the media cache under `key` and return the cached path.
 * Silently returns `sourcePath` on any I/O error so callers always get a usable path.
 */
export function saveToCache(key: string, sourcePath: string): string {
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = cachePathFor(key);
    fs.copyFileSync(sourcePath, dest);
    pruneCache(dir, maxEntries());
    return dest;
  } catch {
    return sourcePath;
  }
}

/** Keep at most `max` cached blobs, deleting the oldest (by mtime) first. */
function pruneCache(dir: string, max: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  if (names.length <= max) return;
  const withTime = names
    .map((name) => {
      const p = nodePath.join(dir, name);
      try {
        return { p, mtime: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { p: string; mtime: number } => e !== null)
    .sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const { p } of withTime.slice(0, withTime.length - max)) {
    fs.rmSync(p, { force: true });
  }
}
