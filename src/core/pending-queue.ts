import { normalizeError } from "../shared/utils/error.js";
import { logger } from "../shared/utils/logger.js";

/**
 * Per-scope debounce queue: items pushed to the same scope within a quiet
 * window are flushed together as one batch. Used to merge rapid-fire chat
 * messages (e.g. a thought split across several sends) into a single prompt
 * before it enters the per-session execution queue.
 *
 * `block(scope)` pauses the quiet window while a run is active on that scope —
 * pushed items still accumulate but no flush fires until `unblock(scope)`,
 * which arms a fresh window. So everything sent during a run lands in Claude
 * as ONE follow-up prompt instead of one turn per message.
 *
 * Commands should bypass this queue — they're cheap and should stay snappy.
 */

/** Batches are never empty: a flush only fires after at least one push. */
export type FlushHandler<T> = (scope: string, batch: [T, ...T[]]) => void | Promise<void>;

interface PendingEntry<T> {
  items: [T, ...T[]];
  timer?: NodeJS.Timeout | undefined;
}

export class PendingQueue<T> {
  private readonly map = new Map<string, PendingEntry<T>>();
  private readonly blocked = new Set<string>();

  constructor(
    private readonly delayMs: number,
    private readonly onFlush: FlushHandler<T>,
  ) {}

  /** Add an item; (re)arms the quiet window unless the scope is blocked.
   * Returns the batch size so far. */
  push(scope: string, item: T): number {
    const existing = this.map.get(scope);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope, existing);
      return existing.items.length;
    }
    const entry: PendingEntry<T> = { items: [item] };
    entry.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope, entry);
    this.map.set(scope, entry);
    return 1;
  }

  /** Pause flushing for a scope (a run started). Items keep accumulating. */
  block(scope: string): void {
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  /** Resume a scope (the run ended): arm a fresh quiet window if anything
   * accumulated while blocked. */
  unblock(scope: string): void {
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    if (entry && !entry.timer) {
      entry.timer = this.armTimer(scope, entry);
    }
  }

  private armTimer(scope: string, entry: PendingEntry<T>): NodeJS.Timeout {
    return setTimeout(() => {
      // Delete before flushing so a push during an async flush starts a
      // fresh batch instead of mutating the one being processed.
      this.map.delete(scope);
      void Promise.resolve()
        .then(() => this.onFlush(scope, entry.items))
        .catch((err) =>
          logger.error(`[pending-queue] flush failed (${scope}): ${normalizeError(err).message}`),
        );
    }, this.delayMs);
  }
}
