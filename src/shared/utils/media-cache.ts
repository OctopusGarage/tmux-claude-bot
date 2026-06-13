import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { appStateFile } from "../state-dir.js";

// Media cache lives under the app state home so it follows TCB_STATE_DIR;
// TCB_MEDIA_DIR still overrides for explicit redirection / tests.
const CACHE_DIR = process.env.TCB_MEDIA_DIR ?? appStateFile("media");

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
