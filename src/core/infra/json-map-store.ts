import * as fs from "node:fs";
import { appStateFile } from "../../shared/state-dir.js";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { logger } from "../../shared/utils/logger.js";

interface CacheEntry<V> {
  path: string;
  mtimeMs: number;
  size: number;
  ino: number;
  map: Record<string, V>;
}

/** A parsed JSON value is usable as a map only if it is a plain object. `null`,
 * arrays and primitives parse without throwing but would crash `key in map` /
 * `map[key]` — they are treated as corruption, not as data. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A persistent string-keyed JSON map kept in one file under the app state dir
 * (see {@link appStateFile}). Shared shape behind group_bindings.json,
 * session_path_map.json and workspaces.json — each used to hand-roll its own
 * read/parse/atomic-write/cache.
 *
 * Reads are served from an in-memory cache keyed by the file's identity
 * (mtime + size + inode), so hot paths (e.g. `isProjectGroup` on every group
 * message) avoid re-parsing — yet a write from ANOTHER process is still picked
 * up, because a foreign write changes one of those and invalidates the cache.
 * (mtime alone is not enough: coarse-resolution filesystems can leave it
 * unchanged for a same-second foreign write, so size + inode are part of the
 * key.) This matters for session_path_map.json, which the `claude-tmux` helper
 * writes from the user's project dir while the bot reads it. Writes are atomic
 * (temp file + rename) and refresh the cache.
 *
 * The file path is resolved per call (never captured at construction) so a
 * changed `TCB_STATE_DIR` — the per-test isolation knob — always takes effect.
 *
 * DATA SAFETY — the store never destroys good data on a bad read. A read that
 * fails (unreadable file, or present-but-unparseable JSON) does NOT silently
 * become an empty map that the next `set`/`delete` would then persist over the
 * real file. Instead a failed read serves the last good in-memory map, so an
 * in-process write merges onto real entries, never onto `{}`. A corrupt file is
 * also backed up to `<file>.corrupt` for recovery. Only a genuinely ABSENT file
 * (ENOENT) is treated as empty. This closes the failure mode where one transient
 * parse error / concurrent-write race wiped every binding at once.
 *
 * Single-process safety: each public op is fully synchronous, so two ops in one
 * process cannot interleave. Cross-process concurrent writers can still lose an
 * update, but the atomic rename guarantees no torn file.
 */
export class JsonMapStore<V> {
  private cache: CacheEntry<V> | null = null;

  constructor(private readonly fileName: string) {}

  private file(): string {
    return appStateFile(this.fileName);
  }

  /** The last good map for `path`, or `{}` when we have nothing cached for it. */
  private lastGood(path: string): Record<string, V> {
    return this.cache?.path === path ? this.cache.map : {};
  }

  /** Best-effort copy of a corrupt file to `<file>.corrupt` so its bytes survive
   * the next write. Swallows all errors; never throws into a read. */
  private backupCorrupt(path: string, raw: string): void {
    try {
      writeFileAtomicSync(`${path}.corrupt`, raw);
      logger.error(
        `[json-map-store] ${this.fileName} is corrupt; backed up to ${this.fileName}.corrupt and kept last-good data`,
      );
    } catch {
      // backup is best-effort — data safety still holds via the last-good cache
    }
  }

  /** Current map, from cache when the file's identity is unchanged. A failed read
   * never downgrades to empty — it serves the last good map (see class doc). */
  private read(): Record<string, V> {
    const path = this.file();
    let st: fs.Stats;
    try {
      st = fs.statSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = null; // file genuinely absent → empty map
        return {};
      }
      // Transient unreadable (EACCES/EBUSY/…): never treat a bound store as empty.
      logger.warn(`[json-map-store] stat failed for ${this.fileName}: ${String(err)}`);
      return this.lastGood(path);
    }

    if (
      this.cache &&
      this.cache.path === path &&
      this.cache.mtimeMs === st.mtimeMs &&
      this.cache.size === st.size &&
      this.cache.ino === st.ino
    ) {
      return this.cache.map;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(path, "utf-8");
    } catch (err) {
      logger.warn(`[json-map-store] read failed for ${this.fileName}: ${String(err)}`);
      return this.lastGood(path);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined; // fall through to the corruption path below
    }
    // Corruption = unparseable OR parsed-but-not-a-plain-object (`null`, `[]`,
    // `123` — these parse fine yet break every consumer). Preserve the bytes, then
    // serve the last good map so an in-process write merges onto real data, not {}.
    // Stamp the cache with THIS (corrupt) file identity so we do NOT re-read /
    // re-back-up / re-log on every subsequent call while it stays corrupt — only
    // when the file changes again (a valid write → new identity) do we re-read.
    if (!isPlainObject(parsed)) {
      this.backupCorrupt(path, raw);
      const served = this.lastGood(path);
      this.cache = { path, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, map: served };
      return served;
    }

    const map = parsed as Record<string, V>;
    this.cache = { path, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, map };
    return map;
  }

  private write(map: Record<string, V>): void {
    const path = this.file();
    writeFileAtomicSync(path, `${JSON.stringify(map, null, 2)}\n`);
    try {
      const st = fs.statSync(path);
      this.cache = { path, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, map };
    } catch {
      this.cache = null; // re-read next time if we can't stamp the cache
    }
  }

  get(key: string): V | undefined {
    return this.read()[key];
  }

  has(key: string): boolean {
    return key in this.read();
  }

  set(key: string, value: V): void {
    const map = { ...this.read() };
    map[key] = value;
    this.write(map);
  }

  delete(key: string): boolean {
    const map = { ...this.read() };
    if (!(key in map)) return false;
    delete map[key];
    this.write(map);
    return true;
  }

  /** Entries sorted by key — the order every list view here wants. */
  sortedEntries(): Array<[string, V]> {
    return Object.entries(this.read()).sort(([a], [b]) => a.localeCompare(b));
  }
}
