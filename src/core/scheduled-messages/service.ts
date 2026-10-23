import { randomUUID } from "node:crypto";
import { type ComponentLogger, createLogger } from "../../shared/utils/logger.js";
import type { HandlerDeps } from "../deps.js";
import { prepareUserPromptDelivery, userPromptQueueFields } from "../read/user-prompt-intake.js";
import { ScheduledMessageStore } from "./store.js";
import { captureScheduledTarget, sameTarget } from "./target.js";
import { parseScheduleTime } from "./time.js";
import {
  type ScheduledMessageRecord,
  type ScheduledTarget,
  type ScheduleEvent,
  type ScheduleOwner,
  sameOwner,
} from "./types.js";
export type CreateSchedule = {
  owner: ScheduleOwner;
  sessionName: string;
  target?: ScheduledTarget;
  text: string;
  when: string | { dueAt: number; timezone: string };
  requestId: string;
};
type Sender = (record: ScheduledMessageRecord, event: ScheduleEvent) => Promise<void>;
export class ScheduledMessageService {
  private readonly senders = new Map<ScheduleOwner["channel"], Sender>();
  private readonly active = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private readonly recoveredUncertain = new Map<string, ScheduledMessageRecord>();
  private recovered = false;
  private readonly logger: ComponentLogger;
  private failed = false;
  private lastFailureLogAt = -Infinity;
  private readonly store: ScheduledMessageStore;
  private readonly now: () => number;
  private readonly probe: (session: string) => Promise<ScheduledTarget>;
  constructor(
    private readonly deps: HandlerDeps,
    options: {
      logger?: ComponentLogger;
      store?: ScheduledMessageStore;
      now?: () => number;
      captureTarget?: (session: string) => Promise<ScheduledTarget>;
    } = {},
  ) {
    this.logger = options.logger ?? createLogger("scheduled-messages");
    this.store = options.store ?? new ScheduledMessageStore();
    this.now = options.now ?? Date.now;
    this.probe = options.captureTarget ?? ((session) => captureScheduledTarget(deps, session));
  }
  private recover(): void {
    if (this.recovered) return;
    const uncertain = this.store.transaction((records) => {
      const recovered: ScheduledMessageRecord[] = [];
      for (const r of records) {
        if (r.status === "sending") {
          r.status = "uncertain";
          r.error = "Bot stopped during submission; inspect the target before retrying";
          r.updatedAt = this.now();
          recovered.push(r);
        } else if (r.status === "queued") {
          r.status = "scheduled";
          r.updatedAt = this.now();
        }
      }
      return recovered;
    });
    for (const record of uncertain) this.recoveredUncertain.set(record.id, record);
    this.recovered = true;
    this.replayRecovered();
  }
  private replayRecovered(channel?: ScheduleOwner["channel"]): void {
    for (const [id, record] of this.recoveredUncertain) {
      if (channel !== undefined && record.owner.channel !== channel) continue;
      const sender = this.senders.get(record.owner.channel);
      if (!sender) continue;
      this.recoveredUncertain.delete(id);
      // Recovery records are already durable. Notification does not read state
      // or affect submission, and a failed transport never resends the prompt.
      void Promise.resolve()
        .then(() =>
          sender(structuredClone(record), {
            kind: "uncertain",
            text: record.error ?? "Submission outcome is uncertain; inspect the target",
          }),
        )
        .catch(() => {});
    }
  }
  captureTarget(sessionName: string): Promise<ScheduledTarget> {
    return this.probe(sessionName);
  }
  async create(input: CreateSchedule): Promise<ScheduledMessageRecord> {
    const existing = this.store
      .read()
      .find((r) => sameOwner(r.owner, input.owner) && r.requestId === input.requestId);
    if (existing) return existing;
    if (!input.text.trim() || !input.requestId.trim())
      throw new Error("Message text and request ID are required");
    const parsed =
      typeof input.when === "string" ? parseScheduleTime(input.when, this.now()) : input.when;
    if (!Number.isSafeInteger(parsed.dueAt) || parsed.dueAt <= this.now() || !parsed.timezone)
      throw new Error("Choose a future time");
    const target = await this.captureTarget(input.sessionName);
    if (input.target && !sameTarget(target, input.target))
      throw new Error("Target session changed; select it again");
    const now = this.now();
    return this.store.transaction((records) => {
      const duplicate = records.find(
        (r) => sameOwner(r.owner, input.owner) && r.requestId === input.requestId,
      );
      if (duplicate) return duplicate;
      if (parsed.dueAt <= this.now()) throw new Error("Choose a future time");
      const record: ScheduledMessageRecord = {
        id: randomUUID(),
        owner: input.owner,
        target,
        text: input.text,
        ...parsed,
        createdAt: now,
        updatedAt: now,
        status: "scheduled",
        requestId: input.requestId,
      };
      records.push(record);
      return record;
    });
  }
  list(owner?: ScheduleOwner): ScheduledMessageRecord[] {
    return this.store.read().filter((r) => !owner || sameOwner(r.owner, owner));
  }
  get(id: string, owner?: ScheduleOwner): ScheduledMessageRecord | undefined {
    return this.list(owner).find((r) => r.id === id);
  }
  cancel(id: string, owner?: ScheduleOwner): ScheduledMessageRecord {
    const record = this.store.transaction((records) => {
      const r = records.find((r) => r.id === id && (!owner || sameOwner(r.owner, owner)));
      if (!r) throw new Error("Scheduled message not found");
      if (r.status === "sent" || r.status === "sending")
        throw new Error("Submission already started; cancellation is unavailable");
      r.status = "cancelled";
      r.updatedAt = this.now();
      return r;
    });
    this.deps.queue.cancelQueued(record.target.sessionName, record.id);
    return record;
  }
  registerSender(channel: ScheduleOwner["channel"], sender: Sender): () => void {
    this.senders.set(channel, sender);
    this.replayRecovered(channel);
    return () => {
      if (this.senders.get(channel) === sender) this.senders.delete(channel);
    };
  }
  start(): () => void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.runTimerTick();
      }, 1000);
      this.timer.unref();
      void this.runTimerTick();
    }
    return () => this.stop();
  }
  private async runTimerTick(): Promise<void> {
    try {
      await this.tick();
      if (this.failed) this.logger.info("Scheduled message scheduler recovered");
      this.failed = false;
    } catch {
      if (!this.failed || this.now() - this.lastFailureLogAt >= 60000) {
        this.logger.error(
          "Scheduled message scheduler failed; delivery remains closed until state is readable",
        );
        this.lastFailureLogAt = this.now();
      }
      this.failed = true;
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private change(id: string, fn: (r: ScheduledMessageRecord) => void): ScheduledMessageRecord {
    return this.store.transaction((records) => {
      const r = records.find((r) => r.id === id);
      if (!r) throw new Error("Scheduled message not found");
      fn(r);
      r.updatedAt = this.now();
      return r;
    });
  }
  private async emit(id: string, event: ScheduleEvent): Promise<void> {
    try {
      const r = this.get(id);
      if (!r) return;
      await this.senders.get(r.owner.channel)?.(r, event);
    } catch {
      /* Notification failures never change delivery state. */
    }
  }
  private async runTick(): Promise<void> {
    this.recover();
    for (const candidate of this.store.read()) {
      if (
        candidate.status !== "scheduled" ||
        candidate.dueAt > this.now() ||
        (candidate.retryAt ?? 0) > this.now() ||
        this.active.has(candidate.id)
      )
        continue;
      const id = candidate.id;
      this.active.add(id);
      try {
        if (!sameTarget(candidate.target, await this.captureTarget(candidate.target.sessionName)))
          throw new Error("Target session changed or was replaced");
        if (!candidate.prepared) {
          const delivery = await prepareUserPromptDelivery(candidate.owner.channel, candidate.text);
          if (!delivery.ok) {
            this.change(id, (r) => {
              if (r.status === "scheduled") {
                r.status = "failed";
                r.error = "Prompt preparation failed";
              }
            });
            await this.emit(id, { kind: "error", text: "Prompt preparation failed" });
            continue;
          }
          this.change(id, (r) => {
            if (r.status === "scheduled") r.prepared = userPromptQueueFields(delivery);
          });
        }
        const record = this.get(id);
        if (record?.status !== "scheduled" || !record.prepared) continue;
        this.change(id, (r) => {
          if (r.status === "scheduled") r.status = "queued";
        });
        const admitted = this.deps.queue.enqueue({
          id,
          dedupeKey: `scheduled:${id}`,
          ephemeral: true,
          ...record.prepared,
          chatId: record.owner.chatId,
          channel: record.owner.channel,
          sessionName: record.target.sessionName,
          action: "text",
          delivery: {
            pinnedTarget: (() => {
              const [serverPid, , , paneId] = record.target.incarnation.split(":");
              if (!serverPid || !paneId || !/^\d+$/.test(serverPid) || !/^%\d+$/.test(paneId))
                throw new Error("Invalid pinned target identity");
              return { serverPid, paneId };
            })(),
            claim: async () => {
              try {
                if (!sameTarget(record.target, await this.captureTarget(record.target.sessionName)))
                  throw new Error("Target session changed or was replaced");
              } catch (error) {
                this.block(id, error);
                return false;
              }
              return this.store.transaction((records) => {
                const r = records.find((r) => r.id === id);
                if (r?.status !== "queued") return false;
                r.status = "sending";
                r.updatedAt = this.now();
                return true;
              });
            },
            sent: () => {
              this.change(id, (r) => {
                if (r.status !== "sending") throw new Error("Submission claim lost");
                r.status = "sent";
                r.sentAt = this.now();
              });
              void this.emit(id, { kind: "sent", text: "Scheduled message submitted" });
            },
            blocked: (reason) => this.block(id, new Error(reason)),
            uncertain: (reason) => {
              this.change(id, (r) => {
                if (r.status === "sending") {
                  r.status = "uncertain";
                  r.error = reason;
                }
              });
              void this.emit(id, { kind: "uncertain", text: reason });
            },
          },
          resolve: (result) => {
            this.active.delete(id);
            const latest = this.change(id, (r) => {
              if (r.status === "sent") r.result = result;
            });
            if (latest.status === "sent") void this.emit(id, { kind: "result", text: result });
          },
          reject: (error) => {
            this.active.delete(id);
            const latest = this.get(id);
            if (latest?.status === "queued") this.block(id, error);
            else if (latest?.status === "sending") {
              this.change(id, (r) => {
                r.status = "uncertain";
                r.error = error.message;
              });
              void this.emit(id, { kind: "uncertain", text: error.message });
            } else if (latest?.status === "sent") {
              this.change(id, (r) => {
                r.error = error.message;
              });
              void this.emit(id, { kind: "error", text: error.message });
            }
          },
        });
        if (admitted === false) {
          this.change(id, (r) => {
            if (r.status === "queued") {
              r.status = "scheduled";
              r.attempts = (r.attempts ?? 0) + 1;
              r.retryAt = this.now() + Math.min(60000, 1000 * 2 ** Math.min(r.attempts, 6));
            }
          });
          this.active.delete(id);
        }
      } catch (error) {
        this.active.delete(id);
        this.block(id, error);
      } finally {
        if (this.get(id)?.status !== "queued" && this.get(id)?.status !== "sending")
          this.active.delete(id);
      }
    }
  }
  private block(id: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const record = this.change(id, (r) => {
      if (r.status === "scheduled" || r.status === "queued") {
        r.status = "blocked";
        r.error = reason;
      }
    });
    if (record.status === "blocked") void this.emit(id, { kind: "blocked", text: reason });
  }
}
const services = new WeakMap<HandlerDeps, ScheduledMessageService>();
export function getScheduledMessageService(deps: HandlerDeps): ScheduledMessageService {
  let service = services.get(deps);
  if (!service) {
    service = new ScheduledMessageService(deps);
    services.set(deps, service);
  }
  return service;
}
