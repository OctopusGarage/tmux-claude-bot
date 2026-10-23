import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../../src/core/command/queue-message.js";
import type { HandlerDeps } from "../../src/core/deps.js";
import { ScheduleDrafts } from "../../src/core/scheduled-messages/drafts.js";
import { ScheduledMessageService } from "../../src/core/scheduled-messages/service.js";
import { ScheduledMessageStore } from "../../src/core/scheduled-messages/store.js";
import type { ComponentLogger } from "../../src/shared/utils/logger.js";

vi.mock("../../src/core/read/user-prompt-intake.js", () => ({
  prepareUserPromptDelivery: vi.fn(async (promptSource, text) => ({
    ok: true,
    text: `prepared:${text}`,
    origin: "user",
    promptSource,
  })),
  userPromptQueueFields: ({ ok, ...fields }: { ok: boolean; text: string }) => fields,
}));
const owner = { channel: "telegram" as const, chatId: "chat", userId: "owner" };
const target = {
  sessionName: "tmux_proj_test",
  label: "test",
  workspacePath: null,
  incarnation: "100:$1:1234:%2",
};
describe("durable scheduling", () => {
  let dir: string,
    now: number,
    items: QueuedMessage[],
    store: ScheduledMessageStore,
    service: ScheduledMessageService;
  let enqueue: ReturnType<typeof vi.fn>;
  let probe: ReturnType<typeof vi.fn<(session: string) => Promise<typeof target>>>;
  const make = () =>
    new ScheduledMessageService(
      { queue: { enqueue, cancelQueued: vi.fn() } } as unknown as HandlerDeps,
      { store, now: () => now, captureTarget: probe },
    );
  const create = (requestId = "one") =>
    service.create({
      owner,
      sessionName: target.sessionName,
      text: "hello\nworld",
      when: "15m",
      requestId,
    });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "schedule-test-"));
    store = new ScheduledMessageStore(join(dir, "messages.json"));
    now = Date.parse("2030-01-01T00:00Z");
    items = [];
    enqueue = vi.fn((msg: QueuedMessage) => {
      items.push(msg);
      return "queued";
    });
    probe = vi.fn(async () => target);
    service = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it("does not enqueue early and duplicates ingress but not intentional equal text", async () => {
    const a = await create();
    expect((await create()).id).toBe(a.id);
    const b = await create("two");
    expect(b.id).not.toBe(a.id);
    await service.tick();
    expect(items).toHaveLength(0);
    now += 900000;
    await Promise.all([service.tick(), service.tick()]);
    expect(items).toHaveLength(2);
    expect(items[0]?.dedupeKey).not.toBe(items[1]?.dedupeKey);
    expect(items[0]).toMatchObject({
      origin: "user",
      promptSource: "telegram",
      ephemeral: true,
      text: "prepared:hello\nworld",
    });
    await service.tick();
    expect(items).toHaveLength(2);
  });
  it("cancellation wins before final submission claim", async () => {
    const r = await create();
    now += 900000;
    await service.tick();
    service.cancel(r.id, owner);
    expect(await items[0]?.delivery?.claim()).toBe(false);
    expect(service.get(r.id)?.status).toBe("cancelled");
  });
  it("claimed sends cannot cancel, mark sent before result and survive notification failure", async () => {
    const r = await create();
    service.registerSender("telegram", async () => {
      throw new Error("offline");
    });
    now += 900000;
    await service.tick();
    expect(await items[0]?.delivery?.claim()).toBe(true);
    expect(() => service.cancel(r.id)).toThrow();
    items[0]?.delivery?.sent();
    expect(service.get(r.id)?.status).toBe("sent");
    items[0]?.resolve("agent reply");
    expect(service.get(r.id)?.result).toBe("agent reply");
    await service.tick();
    expect(items).toHaveLength(1);
  });
  it("recovers queued but never replays interrupted writes", async () => {
    const r = await create();
    now += 900000;
    await service.tick();
    service = make();
    await service.tick();
    expect(items).toHaveLength(2);
    expect(await items[1]?.delivery?.claim()).toBe(true);
    service = make();
    await service.tick();
    expect(service.get(r.id)?.status).toBe("uncertain");
    expect(items).toHaveLength(2);
  });
  it("backs off full queues and preserves prepared input", async () => {
    const r = await create();
    enqueue.mockReturnValue(false);
    now += 900000;
    await service.tick();
    expect(service.get(r.id)?.status).toBe("scheduled");
    await service.tick();
    expect(enqueue).toHaveBeenCalledTimes(1);
    now += 60000;
    enqueue.mockReturnValue("queued");
    await service.tick();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(service.get(r.id)?.prepared?.text).toBe("prepared:hello\nworld");
  });
  it("blocks replaced targets both before admission and after readiness", async () => {
    const r = await create();
    now += 900000;
    await service.tick();
    probe.mockResolvedValue({ ...target, incarnation: "replacement" });
    expect(await items[0]?.delivery?.claim()).toBe(false);
    expect(service.get(r.id)?.status).toBe("blocked");
    await service.tick();
    expect(items).toHaveLength(1);
  });
  it("scopes reads and mutations to all owner dimensions", async () => {
    const r = await create();
    expect(service.get(r.id, { ...owner, userId: "other" })).toBeUndefined();
    expect(() => service.cancel(r.id, { ...owner, channel: "lark" })).toThrow();
    expect(service.list()).toHaveLength(1);
  });
  it("fails closed for malformed and structurally invalid state", () => {
    for (const value of [
      "broken",
      JSON.stringify({ version: 1, records: [{}] }),
      JSON.stringify({ version: 2, records: [] }),
    ]) {
      writeFileSync(store.path, value);
      expect(() => make()).not.toThrow();
      expect(() => service.list()).toThrow();
    }
  });
  it("isolates draft prompts and freezes time, rejects stale callbacks, confirms once", async () => {
    const drafts = new ScheduleDrafts(() => now);
    const a = drafts.create(owner, target);
    drafts.bindPrompt(owner, a.id, "prompt", "text");
    expect(drafts.findPrompt({ ...owner, userId: "other" }, "prompt")).toBeUndefined();
    expect(drafts.findPrompt(owner, "ordinary")).toBeUndefined();
    const b = drafts.update(owner, a.id, { text: "draft text", when: "30m" }, 0);
    expect(b.dueAt).toBe(now + 1800000);
    expect(() => drafts.update(owner, a.id, { text: "stale" }, 0)).toThrow();
    now += 60000;
    const [r, retry] = await Promise.all([
      drafts.confirm(owner, a.id, service, b.revision),
      drafts.confirm(owner, a.id, service, b.revision),
    ]);
    expect(retry.id).toBe(r.id);
    expect(r.dueAt).toBe(b.dueAt);
    expect(service.list()).toHaveLength(1);
  });
  it("expires drafts and rejects elapsed selected times", async () => {
    const drafts = new ScheduleDrafts(() => now);
    const a = drafts.create(owner, target);
    drafts.update(owner, a.id, { text: "text", when: "15m" });
    now += 900001;
    await expect(drafts.confirm(owner, a.id, service)).rejects.toThrow();
    now += 900000;
    expect(drafts.get(owner, a.id)).toBeUndefined();
  });
  it("logs scheduler failures at bounded intervals and logs recovery without error contents", async () => {
    vi.useFakeTimers();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies ComponentLogger;
    const monitored = new ScheduledMessageService(
      { queue: { enqueue, cancelQueued: vi.fn() } } as unknown as HandlerDeps,
      { store, now: () => now, captureTarget: probe, logger },
    );
    const tick = vi
      .spyOn(monitored, "tick")
      .mockRejectedValue(new Error("private body /secret/path"));
    monitored.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    now += 60000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(logger.error).toHaveBeenCalledTimes(2);
    tick.mockResolvedValue();
    await vi.advanceTimersByTimeAsync(1000);
    expect(logger.info).toHaveBeenCalledWith("Scheduled message scheduler recovered");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private body");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret/path");
    monitored.stop();
    vi.useRealTimers();
  });
  it("notifies recovered uncertain submission once after its channel registers", async () => {
    const r = await create();
    now += 900000;
    await service.tick();
    await items[0]?.delivery?.claim();
    service = make();
    const sender = vi.fn(async (_record: unknown, _event: unknown) => {});
    service.registerSender("telegram", sender);
    await Promise.resolve();
    await service.tick();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]?.[1]).toMatchObject({ kind: "uncertain" });
    service.registerSender("telegram", sender);
    await Promise.resolve();
    await service.tick();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(service.get(r.id)?.status).toBe("uncertain");
  });
  it("keeps chat startup available with corrupt schedule state and fails scheduled work closed", async () => {
    const raw = "corrupt private text /private/path";
    writeFileSync(store.path, raw);
    expect(() => {
      service = make();
    }).not.toThrow();
    expect(() => service.registerSender("telegram", async () => {})).not.toThrow();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies ComponentLogger;
    const startup = new ScheduledMessageService(
      { queue: { enqueue, cancelQueued: vi.fn() } } as unknown as HandlerDeps,
      { store, now: () => now, captureTarget: probe, logger },
    );
    expect(() => startup.start()).not.toThrow();
    await expect(startup.tick()).rejects.toThrow();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    await expect(create()).rejects.toThrow();
    expect(readFileSync(store.path, "utf8")).toBe(raw);
    startup.stop();
  });
});
