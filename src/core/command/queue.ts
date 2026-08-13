import * as fs from "node:fs";
import * as nodePath from "node:path";
import { normalizeError } from "../../shared/utils/error.js";
import { runWithLogContext } from "../../shared/utils/log-context.js";
import { createLogger } from "../../shared/utils/logger.js";
import { Queue } from "../../shared/utils/queue.js";
import type { Channel, PersistedMessage, QueuedMessage } from "./queue-message.js";
import { defaultQueueObserver, type QueueObserver } from "./queue-observer.js";

const log = createLogger("command.queue");

// Re-exported from its canonical home (project-manager) so there is a single
// Channel type across core; QueuedMessage carries it, so queue consumers import
// it from here too.
export type { Channel, PersistedMessage, QueuedMessage };

export type QueueHandler = (msg: QueuedMessage) => Promise<void>;

/** Settles a cancelled queued message. A distinct type so an adapter's reject
 * closure can tell a user-initiated cancel apart from a runtime failure and
 * confirm it plainly (not with an error/recovery surface). */
export class QueueCancelledError extends Error {}

/** Actions that type the user's prompt into the agent's pane. The single predicate
 * the idle-gate (hold behind a busy agent) and the streak skip (a completed prompt
 * left the agent idle via waitUntilDone) both key on — so "which actions inject a
 * prompt" lives in one place instead of two scattered `=== "text"` literals. */
function injectsPrompt(action: string): boolean {
  return action === "text";
}

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
  private persistedCarryover = new Map<string, PersistedMessage>();
  /** Optional idle-gate: returns false while the session's agent is busy with
   * work this queue didn't start (e.g. the user driving it on the desktop), so
   * the next message is HELD in the queue instead of being typed into a busy
   * pane. Injected (setReadinessProbe) to keep the queue protocol-agnostic. */
  private readyProbe: ((session: string) => Promise<boolean>) | undefined;
  private readyRecheckMs = 1500;
  private readonly observer: QueueObserver;

  constructor(
    maxSize: number = 30,
    persistPath: string = ".queue/pending.json",
    maxConcurrentSessions: number = Infinity,
    observer: QueueObserver = defaultQueueObserver,
  ) {
    this.maxSize = maxSize;
    this.maxConcurrentSessions = maxConcurrentSessions;
    this.globalQueue = new Queue<QueuedMessage>(maxSize);
    this.persistPath = persistPath;
    this.observer = observer;
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
    const collect = (msg: QueuedMessage, dispatched = false): void => {
      if (msg.ephemeral) return; // local-control messages are never restored
      if (msg.channel !== "control") return; // user chat prompts are never replayed after restart
      messages.push({
        id: msg.id,
        text: msg.text,
        chatId: msg.chatId,
        channel: msg.channel,
        sessionName: msg.sessionName,
        action: msg.action,
        origin: msg.origin,
        promptSource: msg.promptSource,
        sourceText: msg.sourceText,
        transform: msg.transform,
        traceId: msg.traceId,
        controlRestore: msg.controlRestore,
        ackMsgId: msg.ackMsgId,
        ...(dispatched ? { dispatched: true } : {}),
      });
    };
    for (const msg of this.globalQueue.toArray()) collect(msg);
    for (const queue of this.sessionQueues.values()) {
      for (const msg of queue.toArray()) collect(msg);
    }
    if (this.currentGlobalMessage !== undefined) collect(this.currentGlobalMessage, true);
    for (const msg of this.currentSessionMessage.values()) collect(msg, true);
    const liveIds = new Set(messages.map((msg) => msg.id));
    for (const msg of this.persistedCarryover.values()) {
      if (msg.channel === "control" && !liveIds.has(msg.id)) messages.push(msg);
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
    this.persistedCarryover.clear();
    try {
      fs.unlinkSync(this.persistPath);
    } catch {
      // ignore
    }
  }

  /** Keep persisted messages that could not be restored into the live queue.
   * The next queue persistence pass includes this carryover alongside live
   * backlog, so a partial restore does not silently drop work that hit queue
   * capacity or dedupe. */
  keepPersistedCarryover(messages: PersistedMessage[]): void {
    this.persistedCarryover = new Map(messages.map((message) => [message.id, message]));
    this.persist();
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

  /** One lifecycle predicate for host-power drain decisions. Unlike `isEmpty`,
   * this remains true after a message is dequeued and while its handler runs. */
  hasPendingOrRunning(): boolean {
    return !this.isEmpty() || this.processingGlobal || this.processingSessions.size > 0;
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

  /** Cancel ONE still-waiting message by id (never the in-flight ▶ one — that's
   * already typed in; only esc/interrupt stops it). Rejects it so the adapter's
   * pending reply settles (same path as clearSession), and persists. Returns
   * true if a queued message with that id was found. */
  cancelQueued(sessionName: string, msgId: string, reason = "Message cancelled"): boolean {
    const removed = this.sessionQueues.get(sessionName)?.remove((m) => m.id === msgId);
    if (!removed) return false;
    // The reject closure IS the user-facing confirmation (the adapter passes its
    // localized cancellation text as the reason — typed so the closure confirms it
    // plainly instead of showing an error/recovery surface.
    removed.reject(new QueueCancelledError(reason));
    this.persist();
    return true;
  }

  /** Bind the chat-message id of a queued item's "queued" ack to that item, so a
   * reply to the ack can rewrite it ({@link rewriteByAck}). Persisted with the item,
   * so the binding survives a restart. No-op if the item is already gone.
   *
   * The ack's chat-message id only exists AFTER the ack is sent, so the adapter binds
   * it post-enqueue. If the item is dequeued (starts running) in that brief window the
   * bind is a no-op — which is CORRECT: a running item can't be cancelled or rewritten
   * anyway, and a later ❌/reply on its ack then resolves to "no longer queued"
   * (queueItemGone, which points the user at interrupt). So the race needs no guard. */
  setQueueAck(sessionName: string, msgId: string, ackMsgId: string): void {
    const msg = this.sessionQueues
      .get(sessionName)
      ?.toArray()
      .find((m) => m.id === msgId);
    if (!msg) return;
    msg.ackMsgId = ackMsgId;
    this.persist();
  }

  sessionByAck(ackMsgId: string, chatId: string | number): string | null {
    for (const [session, queue] of this.sessionQueues) {
      const msg = queue.toArray().find((m) => m.ackMsgId === ackMsgId && m.chatId === chatId);
      if (msg) return session;
    }
    return null;
  }

  /** Rewrite, in ONE pass, the still-waiting item whose "queued" ack has id
   * `ackMsgId` in chat `chatId` — the single op the reply-to-rewrite handlers need
   * (resolve + rewrite are one logical step). Returns the owning session plus:
   *  - "rewritten": text replaced in place, queue position kept (the queued objects
   *    are live references, so the mutated text is what the handler later sends);
   *  - "duplicate": blocked — `newText` already matches another queued/in-flight item
   *    in this chat, so the rewrite can't manufacture a double-send the enqueue path
   *    would reject (the caller reports it, never silently re-enqueues);
   *  - "not-found": no waiting item with that ack here (already ran, or the reply
   *    wasn't to one of our acks → the caller falls through to normal routing).
   *
   * Scoped by `chatId`, NOT just the ack id: a Telegram message_id is unique only
   * within a chat, so the same id can recur across the owner DM and a group — chat
   * scoping keeps a reply in one chat from rewriting another chat's item, and also
   * separates the channels (their chatId value-spaces don't overlap). Scans the live
   * queue (single source of truth, correct after a restore). */
  rewriteByAck(
    ackMsgId: string,
    chatId: string | number,
    newText: string,
    patch: Partial<
      Pick<QueuedMessage, "origin" | "promptSource" | "sourceText" | "transform">
    > = {},
  ): { kind: "rewritten" | "duplicate"; session: string } | { kind: "not-found" } {
    for (const [session, queue] of this.sessionQueues) {
      const msg = queue.toArray().find((m) => m.ackMsgId === ackMsgId && m.chatId === chatId);
      if (!msg) continue;
      if (msg.action === "text" && this.hasDuplicateText(msg.chatId, newText)) {
        return { kind: "duplicate", session };
      }
      msg.text = newText;
      Object.assign(msg, patch);
      this.persist();
      return { kind: "rewritten", session };
    }
    return { kind: "not-found" };
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
  private async runHandler(msg: QueuedMessage, sessionName: string | undefined): Promise<void> {
    // A real project session times its task; the bot-level pseudo-queue (sessionName
    // undefined) does not — timing it would persist a key into the per-session
    // task-time store that clearTaskTiming, seeing only real session names, never
    // clears. Keying on presence (not a "global" sentinel) keeps the decision in
    // the types and lets a session literally named "global" time correctly.
    if (sessionName !== undefined) this.observer.started(sessionName, msg);
    const label = sessionName ?? "global";
    try {
      await runWithLogContext(
        {
          ...(msg.traceId !== undefined && { traceId: msg.traceId }),
          ...(msg.sessionName !== undefined && { session: msg.sessionName }),
          chatId: msg.chatId,
          ...(msg.channel === "telegram" || msg.channel === "lark" ? { channel: msg.channel } : {}),
        },
        () => this.handler?.(msg) ?? Promise.resolve(),
      );
      log.info(`handler completed session=${label} msgId=${msg.id}`);
    } catch (err) {
      const e = normalizeError(err);
      log.error(`handler threw session=${label} msgId=${msg.id}: ${e.message}`);
      msg.reject(e); // one-shot: a no-op if the handler already settled
    } finally {
      if (sessionName !== undefined) this.observer.finished(sessionName, msg);
    }
  }

  /**
   * @param gated when true (a FRESH start), the idle-gate runs before dequeuing;
   * when false (a streak continuation right after the bot's own task finished),
   * it is skipped — the bot just held the agent via waitUntilDone, so it's idle
   * for us and re-probing would only add latency / a false defer.
   */
  private async processSession(sessionName: string, gated = true): Promise<void> {
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

    // Reserve the slot synchronously BEFORE the idle-gate await, so a concurrent
    // processSession call returns at the guard above — keeping this non-reentrant
    // per session across the await (the message is not yet dequeued).
    this.processingSessions.add(sessionName);

    // Idle-gate: don't type into a pane busy with work this queue didn't start
    // (the user driving the agent on the desktop). Hold the message — leave it
    // QUEUED, so it still counts in size()/queued status — and recheck shortly.
    //
    // ONLY a `text` prompt is gated — it's the one action that types into the
    // agent's input. Control verbs (restart/exit/start/esc/…) must NEVER be held
    // by agent-busy: they're how a user breaks a stuck or desktop-driven agent.
    const head = queue.peek();
    if (
      gated &&
      head !== undefined &&
      injectsPrompt(head.action) &&
      this.readyProbe &&
      !(await this.readyProbe(sessionName))
    ) {
      this.processingSessions.delete(sessionName);
      setTimeout(() => void this.processSession(sessionName), this.readyRecheckMs);
      return;
    }

    const msg = queue.dequeue();
    if (!msg) {
      this.processingSessions.delete(sessionName);
      this.sessionQueues.delete(sessionName);
      return;
    }
    this.currentSessionMessage.set(sessionName, msg);
    log.info(`processing session=${sessionName} action=${msg.action} msgId=${msg.id}`);
    if (msg.started?.() === false) {
      this.processingSessions.delete(sessionName);
      this.currentSessionMessage.delete(sessionName);
      msg.reject(new Error("queued task could not acquire its supervisor lease"));
      void this.processSession(sessionName, false);
      return;
    }
    this.writePersistedNow();

    if (!this.handler) {
      log.error(`handler not set session=${sessionName}`);
      this.processingSessions.delete(sessionName);
      this.currentSessionMessage.delete(sessionName);
      msg.reject(new Error("Queue handler not set"));
      void this.processSession(sessionName, false);
      return;
    }

    await this.runHandler(msg, sessionName);

    this.processingSessions.delete(sessionName);
    this.currentSessionMessage.delete(sessionName);
    this.lastProcessedAt.set(sessionName, Date.now());
    this.persist();
    // Streak continuation: skip the gate for the immediate next message ONLY when
    // we just ran a prompt-injecting task — waitUntilDone left the agent idle for
    // us. After a non-text action (restart/exit/start) the agent may be
    // (re)starting, so the next message must be re-gated, not typed into a half-up agent.
    void this.processSession(sessionName, !injectsPrompt(msg.action));
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
        const msg = this.globalQueue.dequeue();
        if (!msg) break;
        this.currentGlobalMessage = msg;
        log.info(`processing global action=${msg.action} msgId=${msg.id}`);
        this.writePersistedNow();

        if (!this.handler) {
          log.error("handler not set for global message");
          this.currentGlobalMessage = undefined;
          msg.reject(new Error("Queue handler not set"));
          continue;
        }

        await this.runHandler(msg, undefined);
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

  /** Install the idle-gate (see {@link readyProbe}). `recheckMs` is how often a
   * held message re-probes while the agent stays busy. */
  setReadinessProbe(probe: (session: string) => Promise<boolean>, recheckMs?: number): void {
    this.readyProbe = probe;
    if (recheckMs !== undefined) this.readyRecheckMs = recheckMs;
  }
}
