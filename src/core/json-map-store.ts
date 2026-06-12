import * as fs from "node:fs";
import { writeFileAtomicSync } from "../shared/utils/atomic-write.js";
import { appStateFile } from "./state-dir.js";

interface CacheEntry<V> {
  path: string;
  mtimeMs: number;
  map: Record<string, V>;
}

/**
 * A persistent string-keyed JSON map kept in one file under the app state dir
 * (see {@link appStateFile}). Shared shape behind group_bindings.json,
 * session_path_map.json and workspaces.json — each used to hand-roll its own
 * read/parse/atomic-write/cache.
 *
 * Reads are served from an in-memory cache keyed by the file's mtime, so hot
 * paths (e.g. `isProjectGroup` on every group message) avoid re-parsing — yet a
 * write from ANOTHER process is still picked up, because a foreign write changes
 * the mtime and invalidates the cache. This matters for session_path_map.json,
 * which the `claude-tmux` helper writes from the user's project dir while the
 * bot reads it. Writes are atomic (temp file + rename) and refresh the cache.
 *
 * The file path is resolved per call (never captured at construction) so a
 * changed `TCB_STATE_DIR` — the per-test isolation knob — always takes effect.
 *
 * Single-process safety only: each public op is fully synchronous, so two ops
 * in one process cannot interleave (no in-process lost-update). Cross-process
 * concurrent writers can still lose an update, but the atomic rename guarantees
 * no torn file; that residual is pre-existing and acceptable for this app.
 */
export class JsonMapStore<V> {
  private cache: CacheEntry<V> | null = null;

  constructor(private readonly fileName: string) {}

  private file(): string {
    return appStateFile(this.fileName);
  }

  /** Current map, from cache when the file's mtime is unchanged. */
  private read(): Record<string, V> {
    const path = this.file();
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(path).mtimeMs;
    } catch {
      this.cache = null; // missing file → empty map
      return {};
    }
    if (this.cache && this.cache.path === path && this.cache.mtimeMs === mtimeMs) {
      return this.cache.map;
    }
    let map: Record<string, V>;
    try {
      map = JSON.parse(fs.readFileSync(path, "utf-8")) as Record<string, V>;
    } catch {
      map = {}; // corrupt → treat as empty, same as the modules this replaces
    }
    this.cache = { path, mtimeMs, map };
    return map;
  }

  private write(map: Record<string, V>): void {
    const path = this.file();
    writeFileAtomicSync(path, `${JSON.stringify(map, null, 2)}\n`);
    try {
      this.cache = { path, mtimeMs: fs.statSync(path).mtimeMs, map };
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
