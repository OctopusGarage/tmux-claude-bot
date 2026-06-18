import * as fs from "node:fs";
import * as nodePath from "node:path";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("infra.bounded-session-map");

/**
 * A bounded `messageId → session` map: it lets a user's reply to a *specific*
 * bot message route back to the session that message belonged to, instead of
 * the chat's current project. Both adapters drive it identically — an inbound
 * reply carries the replied-to message id (Telegram `reply_to_message`, Lark
 * `replyToMessageId`, both delivered by their SDKs), which is looked up here.
 *
 * Bounded (drop-oldest by insertion order) so it can't grow without limit.
 *
 * Optionally persisted. The referenced tmux sessions outlive a bot restart, so
 * persisting this map keeps reply-routing working across a restart: a reply to
 * an *older* bot message still finds its session instead of falling back to the
 * current project. Persistence is load-once at construction + write-on-change;
 * the runtime instance lock guarantees a single writer, so there are no racing
 * writers. Stored as a JSON array of `[key, session]` entries, which round-trips
 * the key type (number for Telegram, string for Lark) with no parse step — a
 * plain `{id: session}` object would stringify number keys and reorder them.
 *
 * Why both adapters persist (they didn't always): on Telegram, replying to a bot
 * message is THE way to target a session other than the current project, so
 * losing the map on restart is a real regression. On Lark the primary path is
 * per-group workspace binding (`group_bindings.json`), so reply-routing is a
 * secondary convenience there — but it's the same mechanism and persisting it is
 * cheap and independent of Lark's (Phase-1, not-yet-built) queue restore, so
 * both now persist for parity rather than leaving Lark silently degraded.
 */
export class BoundedSessionMap<K extends string | number> {
  private readonly map = new Map<K, string>();
  private readonly max: number;
  private readonly file: string | undefined;

  /** `max` caps the entry count (oldest dropped first). `file`, when given,
   *  backs the map on disk (load-once + write-on-change). */
  constructor(opts: { max: number; file?: string }) {
    this.max = opts.max;
    this.file = opts.file;
    this.load();
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const entries = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Array<[K, string]>;
      for (const [k, v] of entries) this.map.set(k, v);
    } catch (err) {
      log.error(
        `failed to load ${this.file}, starting empty: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(nodePath.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.map.entries()]), "utf-8");
    } catch (err) {
      log.error(`failed to write ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Remember that bot message `id` belongs to `session`. Evicts the oldest
   *  entries once over the cap. */
  record(id: K, session: string): void {
    this.map.set(id, session);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.save();
  }

  resolve(id: K): string | undefined {
    return this.map.get(id);
  }

  /** Forget every entry pointing at `session` (e.g. when its project is removed). */
  removeSession(session: string): void {
    let changed = false;
    for (const [k, v] of this.map) {
      if (v === session) {
        this.map.delete(k);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  clear(): void {
    this.map.clear();
    this.save();
  }
}
