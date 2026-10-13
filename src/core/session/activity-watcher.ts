import * as fs from "node:fs";
import { join } from "node:path";

/**
 * Event-driven "is this transcript being written right now" signal, sourced from
 * the file system rather than polling. Each agent appends to its transcript
 * `.jsonl` as it streams turns/output, so an fs.watch event on that file means
 * the agent is actively working. {@link onActivity} is the documented extension
 * point for future push-notification features — subscribe to be told the instant
 * any transcript is written.
 */
export interface ActivityWatcher {
  /** True if a transcript at `absPath` was written within `ms` (from fs events). */
  isActiveWithin(absPath: string, ms: number): boolean;
  /** Subscribe to every transcript write (the extension point for future push
   * features). Returns an unsubscribe fn. */
  onActivity(listener: (absPath: string) => void): () => void;
  start(): void; // idempotent
  stop(): void;
}

/**
 * Build an {@link ActivityWatcher} over `roots` (the transcript directories of
 * every agent flavor). Watching is recursive, so subdir transcripts
 * (`projects/<dir>/<uuid>.jsonl`, `sessions/YYYY/MM/DD/rollout-*.jsonl`) are
 * covered. A missing or unreadable root is skipped, never thrown.
 */
/** Sweep `lastWrite` once it exceeds this many entries… */
const MAX_TRACKED = 256;
/** …dropping entries untouched for this long (far beyond any active-within window). */
const RETAIN_MS = 5 * 60 * 1000;

export function createActivityWatcher(roots: string[]): ActivityWatcher {
  const lastWrite = new Map<string, number>();
  const listeners = new Set<(absPath: string) => void>();
  const watchers = new Set<fs.FSWatcher>();
  const watchedDirs = new Set<string>();

  function recordWrite(absPath: string): void {
    const now = Date.now();
    lastWrite.set(absPath, now);
    // `isActiveWithin` only cares about writes in the last few seconds, so
    // entries older than the retention window are dead weight. Sweep them
    // when the map grows, so a days-long process doesn't accumulate one
    // entry per transcript file ever written.
    if (lastWrite.size > MAX_TRACKED) {
      for (const [p, t] of lastWrite) if (now - t > RETAIN_MS) lastWrite.delete(p);
    }
    for (const listener of listeners) listener(absPath);
  }

  function watchDir(dir: string): void {
    if (watchedDirs.has(dir)) return;
    watchedDirs.add(dir);
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        const name = filename?.toString();
        if (!name) return;
        const absPath = join(dir, name);
        try {
          if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
            watchDir(absPath);
            return;
          }
        } catch {
          // The path may have disappeared between the event and stat; ignore it.
        }
        if (absPath.endsWith(".jsonl")) recordWrite(absPath);
      });
      watchers.add(watcher);
    } catch {
      // Missing/unreadable directory — skip it; the watcher must not throw on start.
    }
  }

  function watchTree(root: string): void {
    watchDir(root);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        watchTree(join(root, entry.name));
      }
    } catch {
      // Missing/unreadable root — skip it; the watcher must not throw on start.
    }
  }

  function start(): void {
    if (watchers.size > 0) return; // idempotent: don't double-watch
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      watchTree(root);
    }
  }

  function stop(): void {
    for (const watcher of watchers) watcher.close();
    watchers.clear();
    watchedDirs.clear();
  }

  return {
    isActiveWithin(absPath: string, ms: number): boolean {
      return Date.now() - (lastWrite.get(absPath) ?? 0) < ms;
    },
    onActivity(listener: (absPath: string) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
  };
}
