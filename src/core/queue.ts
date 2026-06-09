import * as fs from "node:fs";
import * as nodePath from "node:path";
import { normalizeError } from "../shared/utils/error.js";
import { logger } from "../shared/utils/logger.js";
import { Queue } from "../shared/utils/queue.js";

export type QueuedMessage = {
  id: string;
  text: string;
  chatId: number;
  sessionName?: string | undefined;
  action: string;
  resolve: (output: string) => void;
  reject: (err: Error) => void;
};

export type PersistedMessage = {
  id: string;
  text: string;
  chatId: number;
  sessionName?: string | undefined;
  action: string;
};

export type QueueHandler = (msg: QueuedMessage) => Promise<void>;

export class MessageQueue {
  private readonly sessionQueues = new Map<string, Queue<QueuedMessage>>();
  private readonly globalQueue: Queue<QueuedMessage>;
  private readonly processingSessions = new Set<string>();
  private processingGlobal = false;
  private readonly maxSize: number;
  private handler: QueueHandler | undefined;
  private readonly currentSessionMessage = new Map<string, QueuedMessage>();
  private currentGlobalMessage: QueuedMessage | undefined;
  private readonly lastProcessedAt = new Map<string, number>();
  private readonly persistPath: string;
  private persistScheduled = false;

  constructor(maxSize: number = 30, persistPath: string = ".queue/pending.json") {
    this.maxSize = maxSize;
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
        sessionName: msg.sessionName,
        action: msg.action,
      });
    }
    for (const queue of this.sessionQueues.values()) {
      for (const msg of queue.toArray()) {
        messages.push({
          id: msg.id,
          text: msg.text,
          chatId: msg.chatId,
          sessionName: msg.sessionName,
          action: msg.action,
        });
      }
    }
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(messages, null, 2), "utf-8");
    } catch {
      // ignore persist failures
    }
  }

  loadPersisted(): PersistedMessage[] {
    try {
      const raw = fs.readFileSync(this.persistPath, "utf-8");
      return JSON.parse(raw) as PersistedMessage[];
    } catch {
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

  enqueue(msg: QueuedMessage): boolean {
    if (msg.sessionName) {
      let queue = this.sessionQueues.get(msg.sessionName);
      if (!queue) {
        queue = new Queue<QueuedMessage>(this.maxSize);
        this.sessionQueues.set(msg.sessionName, queue);
      }
      if (!queue.enqueue(msg)) {
        logger.warn(`[queue] enqueue rejected: session=${msg.sessionName} queue full`);
        return false;
      }
      logger.info(
        `[queue] enqueued session=${msg.sessionName} action=${msg.action} msgId=${msg.id}`,
      );
      this.persist();
      void this.processSession(msg.sessionName);
    } else {
      if (!this.globalQueue.enqueue(msg)) {
        logger.warn(`[queue] enqueue rejected: global queue full`);
        return false;
      }
      logger.info(`[queue] enqueued global action=${msg.action} msgId=${msg.id}`);
      this.persist();
      void this.processGlobal();
    }
    return true;
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

  private async runWithRetry(msg: QueuedMessage, sessionName: string): Promise<void> {
    const maxRetries = 3;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.handler?.(msg);
        logger.info(
          `[queue] handler completed session=${sessionName} msgId=${msg.id} attempt=${attempt + 1}`,
        );
        return;
      } catch (err) {
        lastErr = normalizeError(err);
        if (attempt < maxRetries - 1) {
          const delayMs = 1000 * (attempt + 1);
          logger.warn(
            `[queue] handler failed session=${sessionName} msgId=${msg.id} attempt=${attempt + 1}/${maxRetries}, retrying in ${delayMs}ms: ${lastErr.message}`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    logger.error(
      `[queue] handler threw session=${sessionName} msgId=${msg.id} after ${maxRetries} attempts: ${lastErr?.message}`,
    );
    msg.reject(lastErr!);
  }

  private async processSession(sessionName: string): Promise<void> {
    if (this.processingSessions.has(sessionName)) {
      logger.info(`[queue] processSession already processing session=${sessionName}`);
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
    logger.info(`[queue] processing session=${sessionName} action=${msg.action} msgId=${msg.id}`);

    if (!this.handler) {
      logger.error(`[queue] handler not set session=${sessionName}`);
      this.processingSessions.delete(sessionName);
      this.currentSessionMessage.delete(sessionName);
      msg.reject(new Error("Queue handler not set"));
      void this.processSession(sessionName);
      return;
    }

    await this.runWithRetry(msg, sessionName);

    this.processingSessions.delete(sessionName);
    this.currentSessionMessage.delete(sessionName);
    this.lastProcessedAt.set(sessionName, Date.now());
    this.persist();
    void this.processSession(sessionName);
  }

  private async processGlobal(): Promise<void> {
    if (this.processingGlobal) {
      logger.info("[queue] processGlobal already running");
      return;
    }
    this.processingGlobal = true;
    logger.info("[queue] processGlobal started");

    try {
      while (!this.globalQueue.isEmpty()) {
        const msg = this.globalQueue.dequeue()!;
        this.currentGlobalMessage = msg;
        logger.info(`[queue] processing global action=${msg.action} msgId=${msg.id}`);

        if (!this.handler) {
          logger.error("[queue] handler not set for global message");
          this.currentGlobalMessage = undefined;
          msg.reject(new Error("Queue handler not set"));
          continue;
        }

        await this.runWithRetry(msg, "global");
        this.currentGlobalMessage = undefined;
      }
    } finally {
      this.processingGlobal = false;
      this.persist();
      logger.info("[queue] processGlobal finished");
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
