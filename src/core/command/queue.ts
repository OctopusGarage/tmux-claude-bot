import * as fs from "node:fs";
import * as nodePath from "node:path";
import { normalizeError } from "../../shared/utils/error.js";
import { runWithLogContext } from "../../shared/utils/log-context.js";
import { createLogger } from "../../shared/utils/logger.js";
import { Queue } from "../../shared/utils/queue.js";
import type { Channel } from "../projects/project-manager.js";

const log = createLogger("command.queue");

// Re-exported from its canonical home (project-manager) so there is a single
// Channel type across core; QueuedMessage carries it, so queue consumers import
// it from here too.
export type { Channel };

export type QueuedMessage = {
  id: string;
  text: string;
  chatId: string | number;
  channel?: Channel | undefined;
  sessionName?: string | undefined;
  action: string;
  traceId?: string | undefined;
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  /** Optional interim-progress channel: sends a message to the chat while the
   * run is still in flight (resolve/reject remain the one-shot finale). */
  notify?: ((text: string) => void) | undefined;
};

export type PersistedMessage = {
  id: string;
  text: string;
  chatId: string | number;
  channel?: Channel | undefined;
  sessionName?: string | undefined;
  action: string;
  traceId?: string | undefined;
};

export type QueueHandler = (msg: QueuedMessage) => Promise<void>;

export class MessageQueue {
  private readonly sessionQueues = new Map<string, Queue<QueuedMessage>>();
  private readonly globalQueue: Queue<QueuedMessage>;
  private readonly processingSessions = new Set<string>();
  private processingGlobal = false;
  private readonly maxSize: number;
  private readonly maxConcurrentSessions: number;
  private handler: QueueHandler | undefined;
  private readonly currentSessionMessage = new Map<string, QueuedMessage>();
  private currentGlobalMessage: QueuedMessage | undefined;
  private readonly lastProcessedAt = new Map<string, number>();
  private readonly persistPath: string;
  private persistScheduled = false;

  constructor(
    maxSize: number = 30,
    persistPath: string = ".queue/pending.json",
    maxConcurrentSessions: number = Infinity,
  ) {
    this.maxSize = maxSize;
    this.maxConcurrentSessions = maxConcurrentSessions;
    this.globalQueue = new Queue<QueuedMessage>(maxSize);
    this.persistPath = persistPath;
    this.ensurePersistDir();
  }

  private ensurePersistDir(): void {
    const dir = nodePath.dirname(this.persistPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore (directory may already exist or be unwritable)
    }
  }

  private persist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    process.nextTick(() => {
      if (!this.persistScheduled) return;
      this.persistScheduled = false;
      this.writePersistedNow();
    });
  }

  flushPending(): void {
    if (!this.persistScheduled) return;
    this.persistScheduled = false;
    this.writePersistedNow();
  }

  private writePersistedNow(): void {
    const messages: PersistedMessage[] = [];
    for (const msg of this.globalQueue.toArray()) {
      messages.push({
        id: msg.id,
        text: msg.text,
        chatId: msg.chatId,
        channel: msg.channel,
        sessionName: msg.sessionName,
        action: msg.action,
        traceId: msg.traceId,
      });
    }
    for (const queue of this.sessionQueues.values()) {
      for (const msg of queue.toArray()) {
        messages.push({
          id: msg.id,
          text: msg.text,
          chatId: msg.chatId,
          channel: msg.channel,
          sessionName: msg.sessionName,
          action: msg.action,
          traceId: msg.traceId,
        });
      }
    }
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(messages, null, 2), "utf-8");
    } catch (err) {
      // Best-effort, but a failure means queued work won't survive a restart.
      log.warn("failed to persist queue backlog", { err, data: { count: messages.length } });
    }
  }

  loadPersisted(): PersistedMessage[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistPath, "utf-8");
    } catch {
      return []; // no backlog file — the normal cold-start case, not an error
    }
    try {
      return JSON.parse(raw) as PersistedMessage[];
    } catch (err) {
      // The file exists but is corrupt — surface it, the backlog is being dropped.
      log.warn("failed to parse persisted queue backlog — dropping it", { err });
      return [];
    }
  }

  clearPersisted(): void {
    try {
      fs.unlinkSync(this.persistPath);
    } catch {
      // ignore
    }
  }

  /** Remove only one channel's persisted messages, leaving other channels for
   * their own adapter to restore. Each adapter restores + drops its own channel
   * on boot, so a Telegram+Lark deployment doesn't lose either side's backlog and
   * neither double-restores. Legacy entries without a channel are treated as
   * Telegram (that is who wrote them before the field existed). Unlinks the file
   * when nothing remains. */
  clearPersistedChannel(channel: Channel): void {
    const remaining = this.loadPersisted().filter((m) => (m.channel ?? "telegram") !== channel);
    if (remaining.length === 0) {
      this.clearPersisted();
      return;
    }
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(remaining, null, 2), "utf-8");
    } catch {
      // ignore persist failures
    }
  }

  private hasDuplicateText(chatId: string | number, text: string): boolean {
    const matches = (m: QueuedMessage | undefined): boolean =>
      m !== undefined && m.action === "text" && m.chatId === chatId && m.text === text;
    const isDup = (q: Queue<QueuedMessage>): boolean => q.toArray().some(matches);
    // Iterate the queues directly instead of spreading them into a fresh array
    // on every enqueue. (A side index keyed by chatId+text would be faster still,
    // but keeping it in sync across enqueue/dequeue/clear isn't worth it for a
    // per-session queue bounded at maxSize.)
    if (isDup(this.globalQueue)) return true;
    for (const q of this.sessionQueues.values()) {
      if (isDup(q)) return true;
    }
    // Also match the messages currently in flight (dequeued but still being typed
    // into the pane). Without this, re-sending identical text DURING processing
    // slips past dedup and gets typed a second time.
    if (matches(this.currentGlobalMessage)) return true;
    for (const m of this.currentSessionMessage.values()) {
      if (matches(m)) return true;
    }
    return false;
  }

  /** "queued" and "duplicate" are both truthy (callers that only check
   * success need no change), but a deduped message is dropped without ever
   * firing resolve/reject — callers holding resources tied to settlement
   * (e.g. a blocked debounce scope) must release them on "duplicate". */
  enqueue(msg: QueuedMessage): "queued" | "duplicate" | false {
    if (msg.action === "text" && this.hasDuplicateText(msg.chatId, msg.text)) {
      log.info(
        `dedup: skipping identical text from chatId=${msg.chatId} session=${msg.sessionName ?? "global"}`,
      );
      return "duplicate";
    }

    if (msg.sessionName) {
      let queue = this.sessionQueues.get(msg.sessionName);
      if (!queue) {
        queue = new Queue<QueuedMessage>(this.maxSize);
        this.sessionQueues.set(msg.sessionName, queue);
      }
      if (!queue.enqueue(msg)) {
        log.warn(`enqueue rejected: session=${msg.sessionName} queue full`);
        return false;
      }
      log.info(`enqueued session=${msg.sessionName} action=${msg.action} msgId=${msg.id}`);
      this.persist();
      void this.processSession(msg.sessionName);
    } else {
      if (!this.globalQueue.enqueue(msg)) {
        log.warn(`enqueue rejected: global queue full`);
        return false;
      }
      log.info(`enqueued global action=${msg.action} msgId=${msg.id}`);
      this.persist();
      void this.processGlobal();
    }
    return "queued";
  }

  isEmpty(): boolean {
    if (!this.globalQueue.isEmpty()) return false;
    for (const queue of this.sessionQueues.values()) {
      if (!queue.isEmpty()) return false;
    }
    return true;
  }

  size(sessionName?: string): number {
    if (sessionName) {
      return this.sessionQueues.get(sessionName)?.size() ?? 0;
    }
    let total = this.globalQueue.size();
    for (const queue of this.sessionQueues.values()) {
      total += queue.size();
    }
    return total;
  }

  getSessionQueue(sessionName: string): readonly QueuedMessage[] {
    return this.sessionQueues.get(sessionName)?.toArray() ?? [];
  }

  getGlobalQueue(): readonly QueuedMessage[] {
    return this.globalQueue.toArray();
  }

  getSessionNames(): string[] {
    const names: string[] = [];
    for (const [name, queue] of this.sessionQueues.entries()) {
      if (!queue.isEmpty() || this.processingSessions.has(name)) {
        names.push(name);
      }
    }
    return names;
  }

  clearSession(sessionName: string): void {
    const queue = this.sessionQueues.get(sessionName);
    if (queue) {
      while (!queue.isEmpty()) {
        const msg = queue.dequeue();
        if (msg) {
          msg.reject(new Error("Session removed, message cancelled"));
        }
      }
      this.sessionQueues.delete(sessionName);
    }
    this.currentSessionMessage.delete(sessionName);
    this.lastProcessedAt.delete(sessionName);
    this.persist();
  }

  clear(): void {
    for (const queue of this.sessionQueues.values()) {
      queue.clear();
    }
    this.sessionQueues.clear();
    this.globalQueue.clear();
    this.currentSessionMessage.clear();
    this.currentGlobalMessage = undefined;
    this.lastProcessedAt.clear();
    this.persistScheduled = false;
    this.clearPersisted();
  }

  /**
   * Run the handler for one message. The handler owns settling the message —
   * resolve/reject is its one-shot finale (see {@link QueuedMessage}) — so it
   * is not expected to throw. This is only a contract safety net: if it throws
   * *without* settling, reject so the awaiting caller doesn't hang forever.
   *
   * No retry: the handler drives tmux (`sendKeys`), which is not idempotent to
   * replay — re-running it would type the same prompt into the pane again.
   */
  private async runHandler(msg: QueuedMessage, sessionName: string): Promise<void> {
    try {
      await runWithLogContext(
        {
          ...(msg.traceId !== undefined && { traceId: msg.traceId }),
          ...(msg.sessionName !== undefined && { session: msg.sessionName }),
          chatId: msg.chatId,
          ...(msg.channel !== undefined && { channel: msg.channel }),
        },
        () => this.handler?.(msg) ?? Promise.resolve(),
      );
      log.info(`handler completed session=${sessionName} msgId=${msg.id}`);
    } catch (err) {
      const e = normalizeError(err);
      log.error(`handler threw session=${sessionName} msgId=${msg.id}: ${e.message}`);
      msg.reject(e); // one-shot: a no-op if the handler already settled
    }
  }

  private async processSession(sessionName: string): Promise<void> {
    if (this.processingSessions.has(sessionName)) {
      log.info(`processSession already processing session=${sessionName}`);
      return;
    }

    if (this.processingSessions.size >= this.maxConcurrentSessions) {
      log.info(
        `concurrent limit reached (${this.processingSessions.size}/${this.maxConcurrentSessions}), deferring session=${sessionName}`,
      );
      // Two deferred timers for the same session can both fire when a slot frees,
      // but this is NOT a double-processing bug: the guard above and the
      // `processingSessions.add` below are synchronously contiguous (no `await`
      // between them), so single-threaded JS guarantees the first firing adds the
      // session before the second runs — the second then returns at the guard.
      // processSession is effectively non-reentrant per session. Worst case is one
      // wasted no-op timer, not two concurrent runs.
      setTimeout(() => void this.processSession(sessionName), 1000);
      return;
    }

    const queue = this.sessionQueues.get(sessionName);
    if (!queue || queue.isEmpty()) {
      this.sessionQueues.delete(sessionName);
      return;
    }

    const msg = queue.dequeue()!;
    this.processingSessions.add(sessionName);
    this.currentSessionMessage.set(sessionName, msg);
    log.info(`processing session=${sessionName} action=${msg.action} msgId=${msg.id}`);

    if (!this.handler) {
      log.error(`handler not set session=${sessionName}`);
      this.processingSessions.delete(sessionName);
      this.currentSessionMessage.delete(sessionName);
      msg.reject(new Error("Queue handler not set"));
      void this.processSession(sessionName);
      return;
    }

    await this.runHandler(msg, sessionName);

    this.processingSessions.delete(sessionName);
    this.currentSessionMessage.delete(sessionName);
    this.lastProcessedAt.set(sessionName, Date.now());
    this.persist();
    void this.processSession(sessionName);
  }

  private async processGlobal(): Promise<void> {
    if (this.processingGlobal) {
      log.info("processGlobal already running");
      return;
    }
    this.processingGlobal = true;
    log.info("processGlobal started");

    try {
      while (!this.globalQueue.isEmpty()) {
        const msg = this.globalQueue.dequeue()!;
        this.currentGlobalMessage = msg;
        log.info(`processing global action=${msg.action} msgId=${msg.id}`);

        if (!this.handler) {
          log.error("handler not set for global message");
          this.currentGlobalMessage = undefined;
          msg.reject(new Error("Queue handler not set"));
          continue;
        }

        await this.runHandler(msg, "global");
        this.currentGlobalMessage = undefined;
      }
    } finally {
      this.processingGlobal = false;
      this.persist();
      log.info("processGlobal finished");
    }
  }

  isSessionProcessing(sessionName: string): boolean {
    return this.processingSessions.has(sessionName);
  }

  isGlobalProcessing(): boolean {
    return this.processingGlobal;
  }

  getCurrentSessionMessage(sessionName: string): QueuedMessage | undefined {
    return this.currentSessionMessage.get(sessionName);
  }

  getCurrentGlobalMessage(): QueuedMessage | undefined {
    return this.currentGlobalMessage;
  }

  getLastProcessedAt(sessionName: string): number | undefined {
    return this.lastProcessedAt.get(sessionName);
  }

  getMaxSize(): number {
    return this.maxSize;
  }

  setHandler(handler: QueueHandler): void {
    this.handler = handler;
  }
}
