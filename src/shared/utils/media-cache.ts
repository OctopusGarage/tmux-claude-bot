import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

const CACHE_DIR =
  process.env.TCB_MEDIA_DIR ?? nodePath.join(os.homedir(), ".tmux-claude-bot", "media");

function cachePathFor(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return nodePath.join(CACHE_DIR, hash);
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
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const dest = cachePathFor(key);
    fs.copyFileSync(sourcePath, dest);
    return dest;
  } catch {
    return sourcePath;
  }
}
