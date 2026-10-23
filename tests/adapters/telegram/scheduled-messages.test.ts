import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  scheduleCalendarDays,
  scheduleCallbackData,
} from "../../../src/adapters/telegram/scheduled-messages.js";

describe("Telegram scheduled-message controls", () => {
  it("uses compact references and rejects oversized callback payloads", () => {
    expect(scheduleCallbackData("d", "a".repeat(16), 12, "15m")).toBe(
      "sm:d:aaaaaaaaaaaaaaaa:c:15m",
    );
    expect(() => scheduleCallbackData("d", "x".repeat(65), 1)).toThrow();
  });
  it("builds real month days across leap-year and year boundaries", () => {
    expect(scheduleCalendarDays(2028, 1)).toHaveLength(29);
    expect(scheduleCalendarDays(2027, 1)).toHaveLength(28);
    expect(scheduleCalendarDays(2026, 12)[0]).toBe("2027-01-01");
  });
});

import type { Bot, Context } from "grammy";
import { registerHandlers } from "../../../src/adapters/telegram/handlers.js";
import * as projectOperations from "../../../src/adapters/telegram/project-ops.js";
import {
  handleScheduleCallback,
  handleScheduleCommand,
  handleScheduleReply,
  registerScheduledTelegramSender,
} from "../../../src/adapters/telegram/scheduled-messages.js";
import { scheduledMessageCatalogs } from "../../../src/core/i18n/catalog/scheduled-messages.js";
import { scheduleMessages } from "../../../src/core/i18n/scheduled-messages.js";
import * as picker from "../../../src/core/projects/project-session-picker.js";
import * as draftModule from "../../../src/core/scheduled-messages/drafts.js";
import * as serviceModule from "../../../src/core/scheduled-messages/service.js";
import type {
  ScheduledMessageRecord,
  ScheduledTarget,
} from "../../../src/core/scheduled-messages/types.js";
import { fakeBot, fakeCtx, fakeDeps } from "./_fakes.js";

const target: ScheduledTarget = {
  sessionName: "project_alpha",
  label: "Alpha",
  workspacePath: "/synthetic/alpha",
  incarnation: "generation-1",
};
const owner = { channel: "telegram" as const, chatId: "100", userId: "7" };
const targets = {
  record: vi.fn(),
  resolve: vi.fn((): string | undefined => undefined),
  removeSession: vi.fn(),
  clear: vi.fn(),
};
let memory: draftModule.ScheduleDrafts;
let records: ScheduledMessageRecord[];
let deps: ReturnType<typeof fakeDeps>;
type SchedulerMethods = Pick<
  serviceModule.ScheduledMessageService,
  "captureTarget" | "create" | "list" | "get" | "cancel" | "registerSender"
>;
let scheduler: { [Key in keyof SchedulerMethods]: Mock<SchedulerMethods[Key]> };

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error("Expected workflow value");
  return value;
}
function context(options: Parameters<typeof fakeCtx>[0] = {}, userId = 7) {
  const ctx = fakeCtx(options);
  if (options.callbackData !== undefined) Object.assign(ctx, { message: undefined });
  Object.assign(ctx, {
    from: { id: userId },
    chat: { id: options.chatId ?? 100, type: "private" },
  });
  return ctx;
}
function buttons(ctx: ReturnType<typeof context>): { text: string; callback_data: string }[] {
  return ctx.replies.flatMap(
    (r) =>
      (
        r.extra.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] }
      )?.inline_keyboard?.flat() ?? [],
  );
}
async function click(data: string, userId = 7) {
  const ctx = context({ callbackData: data }, userId);
  expect(await handleScheduleCallback(ctx, deps, targets)).toBe(true);
  return ctx;
}
beforeEach(() => {
  vi.restoreAllMocks();
  memory = new draftModule.ScheduleDrafts();
  records = [];
  deps = fakeDeps({ currentProject: { get: vi.fn(async () => target.sessionName), set: vi.fn() } });
  scheduler = {
    captureTarget: vi.fn(async () => target),
    create: vi.fn(async (input) => {
      const record = {
        id: "a63cb896-f6ba-4659-b7dd-1688d226a959",
        ...input,
        target: input.target ?? target,
        dueAt: typeof input.when === "string" ? Date.parse(input.when) : input.when.dueAt,
        timezone: "UTC",
        status: "scheduled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as ScheduledMessageRecord;
      records.push(record);
      return record;
    }),
    list: vi.fn((own) => records.filter((r) => JSON.stringify(r.owner) === JSON.stringify(own))),
    get: vi.fn((id, own) =>
      records.find((r) => r.id === id && JSON.stringify(r.owner) === JSON.stringify(own)),
    ),
    cancel: vi.fn((id, own) => {
      const record = scheduler.get(id, own);
      if (!record) throw new Error("missing");
      record.status = "cancelled";
      return record;
    }),
    registerSender: vi.fn(() => vi.fn()),
  };
  vi.spyOn(draftModule, "getScheduleDrafts").mockReturnValue(memory);
  vi.spyOn(serviceModule, "getScheduledMessageService").mockReturnValue(
    scheduler as unknown as serviceModule.ScheduledMessageService,
  );
});

describe("Telegram scheduling workflow", () => {
  it("opens a unique ForceReply draft and only submits after explicit confirmation", async () => {
    const start = context({ text: "/schedule" });
    await handleScheduleCommand(start, deps, targets);
    const prompt = start.replies.find(
      (r) => (r.extra.reply_markup as { force_reply?: boolean }).force_reply,
    );
    expect(prompt).toBeDefined();
    expect(scheduler.create).not.toHaveBeenCalled();
    const text = context({
      text: "Review tests\nPreserve this second line",
      replyToMessageId: 1001,
    });
    expect(await handleScheduleReply(text, targets)).toBe(true);
    const times = buttons(text);
    const pick = required(times.find((b) => b.text === scheduleMessages("telegram").in15m));
    const review = await click(pick.callback_data);
    expect(scheduler.create).not.toHaveBeenCalled();
    expect(review.texts().join("\n")).toContain("Review tests\nPreserve this second line");
    const confirm = required(
      buttons(review).find((b) => b.text === scheduleMessages("telegram").confirm),
    );
    await click(confirm.callback_data);
    await click(confirm.callback_data);
    expect(scheduler.create).toHaveBeenCalledTimes(1);
    expect(records[0]?.text).toBe("Review tests\nPreserve this second line");
    expect(deps.currentProject.set).not.toHaveBeenCalled();
  });
  it("ignores ordinary messages and other owners' replies", async () => {
    await handleScheduleCommand(context({ text: "/schedule" }), deps, targets);
    expect(await handleScheduleReply(context({ text: "normal message" }), targets)).toBe(false);
    expect(
      await handleScheduleReply(context({ text: "foreign", replyToMessageId: 1001 }, 9), targets),
    ).toBe(false);
    expect(scheduler.create).not.toHaveBeenCalled();
  });
  it("rejects stale and cross-owner callbacks with restart buttons", async () => {
    const draft = memory.create(owner, target);
    memory.update(owner, draft.id, { text: "body" }, 0);
    const stale = await click(scheduleCallbackData("at", draft.id, 0, "15m"));
    const foreign = await click(scheduleCallbackData("discard", draft.id, 1), 9);
    expect(stale.texts().join()).toContain(scheduleMessages("telegram").expired);
    expect(foreign.texts().join()).toContain(scheduleMessages("telegram").expired);
    expect(memory.get(owner, draft.id)).toBeDefined();
  });
  it("preserves a direct command's multiline body and reply-resolved target", async () => {
    targets.resolve.mockReturnValueOnce("reply_target");
    await handleScheduleCommand(
      context({ text: "/schedule 30m First line\nSecond line", replyToMessageId: 12 }),
      deps,
      targets,
    );
    expect(scheduler.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "reply_target",
        text: "First line\nSecond line",
        owner,
      }),
    );
  });
  it("walks the native date/hour/minute picker and renders bounded callbacks", async () => {
    const draft = memory.update(owner, memory.create(owner, target).id, { text: "body" });
    const calendar = await click(scheduleCallbackData("calendar", draft.id, draft.revision));
    expect(buttons(calendar).length).toBeGreaterThan(28);
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const hours = await click(scheduleCallbackData("date", draft.id, draft.revision, value));
    const minutes = await click(
      required(buttons(hours).find((b) => b.text === "09")).callback_data,
    );
    const review = await click(
      required(buttons(minutes).find((b) => b.text === "30")).callback_data,
    );
    expect(buttons(review).some((b) => b.text === scheduleMessages("telegram").confirm)).toBe(true);
    expect(
      [...buttons(calendar), ...buttons(hours), ...buttons(minutes), ...buttons(review)].every(
        (b) => Buffer.byteLength(b.callback_data) <= 64,
      ),
    ).toBe(true);
    expect(scheduler.create).not.toHaveBeenCalled();
  });
  it("blocks target picking in group chats", async () => {
    const draft = memory.create(owner, target);
    const ctx = context({ callbackData: scheduleCallbackData("target", draft.id, 0, "abc123") });
    Object.assign(ctx, { chat: { id: 100, type: "group" } });
    await handleScheduleCallback(ctx, deps, targets);
    expect(scheduler.captureTarget).not.toHaveBeenCalled();
    expect(memory.get(owner, draft.id)?.target).toEqual(target);
  });
  it("scopes list/show/cancel to the owner and shows cancellation in details", async () => {
    await handleScheduleCommand(context({ text: "/schedule 30m body" }), deps, targets);
    const list = await click(scheduleCallbackData("list"));
    const detail = await click(required(buttons(list)[0]).callback_data);
    await click(
      required(buttons(detail).find((b) => b.text === scheduleMessages("telegram").cancel))
        .callback_data,
    );
    expect(records[0]?.status).toBe("cancelled");
    expect(scheduler.cancel).toHaveBeenCalledWith(records[0]?.id, owner);
    const foreign = await click(scheduleCallbackData("show", required(records[0]).id), 9);
    expect(foreign.texts().join()).toContain(scheduleMessages("telegram").notFound);
  });
  it("registers a persistent sender without capturing update context", async () => {
    const bot = fakeBot();
    registerScheduledTelegramSender(bot, deps, targets);
    await handleScheduleCommand(context({ text: "/schedule 30m body" }), deps, targets);
    const sender = required(scheduler.registerSender.mock.calls[0])[1];
    await sender(required(records[0]), { kind: "result", text: "Agent result" });
    expect(bot.texts().join()).toContain("Agent result");
    expect(bot.sent[0]?.chatId).toBe(100);
    expect(bot.sent[0]?.extra.reply_markup).toBeDefined();
  });
});

describe("dedicated prompt safety", () => {
  it("consumes a discarded prompt reply instead of forwarding it as ordinary input", async () => {
    const ctx = context({ text: "/schedule" });
    await handleScheduleCommand(ctx, deps, targets);
    const discard = required(
      buttons(ctx).find((b) => b.text === scheduleMessages("telegram").discard),
    );
    await click(discard.callback_data);
    const late = context({ text: "This was only a scheduled draft", replyToMessageId: 1001 });
    expect(await handleScheduleReply(late, targets)).toBe(true);
    expect(late.texts().join()).toContain(scheduleMessages("telegram").expired);
    expect(scheduler.create).not.toHaveBeenCalled();
  });
  it("invalidates hour buttons after selecting another date", async () => {
    const draft = memory.update(owner, memory.create(owner, target).id, { text: "body" });
    const hours = await click(scheduleCallbackData("date", draft.id, draft.revision, "2099-01-01"));
    const obsolete = required(buttons(hours).find((b) => b.text === "09"));
    const current = required(memory.get(owner, draft.id));
    await click(scheduleCallbackData("date", current.id, current.revision, "2099-01-02"));
    const rejected = await click(obsolete.callback_data);
    expect(rejected.texts().join()).toContain(scheduleMessages("telegram").expired);
  });
});

describe("review and target controls", () => {
  it("preserves timing guidance and status when previewing long content", async () => {
    const text = `${"A".repeat(6000)}final content line`;
    const draft = memory.update(owner, memory.create(owner, target).id, { text, when: "1h" });
    const review = await click(scheduleCallbackData("review", draft.id, draft.revision));
    expect(review.texts().join()).toContain(scheduleMessages("telegram").timingNote);
    expect(review.texts().join()).not.toContain("A".repeat(2000));
    const confirmed = await click(scheduleCallbackData("confirm", draft.id, draft.revision));
    expect(confirmed.texts().join()).toContain(scheduleMessages("telegram").status);
    expect(confirmed.texts().join()).toContain(scheduleMessages("telegram").scheduled);
    expect(records[0]?.text).toBe(text);
  });
  it("lets the owner inspect every page of long content before confirming", async () => {
    const text = `${"A".repeat(3600)}final content line`;
    const draft = memory.update(owner, memory.create(owner, target).id, { text, when: "1h" });
    const review = await click(scheduleCallbackData("review", draft.id, draft.revision));
    const full = buttons(review).find((b) => b.text === scheduleMessages("telegram").fullText);
    expect(full).toBeDefined();
    const first = await click(full?.callback_data ?? "");
    const next = buttons(first).find((b) => b.text === scheduleMessages("telegram").next);
    expect(next).toBeDefined();
    const last = await click(next?.callback_data ?? "");
    expect(last.texts().join()).toContain("final content line");
    expect(scheduler.create).not.toHaveBeenCalled();
  });
  it("keeps the captured target when the chat's current project changes", async () => {
    const start = context({ text: "/schedule" });
    await handleScheduleCommand(start, deps, targets);
    vi.mocked(deps.currentProject.get).mockResolvedValue("project_other");
    const message = context({ text: "pinned body", replyToMessageId: 1001 });
    await handleScheduleReply(message, targets);
    const review = await click(
      buttons(message).find((b) => b.text === scheduleMessages("telegram").in15m)?.callback_data ??
        "",
    );
    await click(
      buttons(review).find((b) => b.text === scheduleMessages("telegram").confirm)?.callback_data ??
        "",
    );
    expect(records[0]?.target.sessionName).toBe(target.sessionName);
    expect(deps.currentProject.set).not.toHaveBeenCalled();
  });
  it("binds typed-time edits to their own dedicated reply prompt", async () => {
    const draft = memory.update(owner, memory.create(owner, target).id, { text: "body" });
    const prompt = await click(scheduleCallbackData("typed", draft.id, draft.revision));
    expect(prompt.replies[0]?.extra.reply_markup).toEqual({ force_reply: true, selective: false });
    const review = context({ text: "1h", replyToMessageId: 1001 });
    expect(await handleScheduleReply(review, targets)).toBe(true);
    expect(buttons(review).some((b) => b.text === scheduleMessages("telegram").confirm)).toBe(true);
  });
});

describe("scheduled-message ingress wiring", () => {
  it("registers /schedule and intercepts its callbacks and prompt replies", async () => {
    const commands = new Map<string, (ctx: Context) => Promise<void>>();
    const events = new Map<string, (ctx: Context) => Promise<void>>();
    const bot = {
      command: vi.fn((name: string, handler: (ctx: Context) => Promise<void>) =>
        commands.set(name, handler),
      ),
      on: (event: string, handler: (ctx: Context) => Promise<void>) => events.set(event, handler),
    };
    registerHandlers(bot as unknown as Bot, deps, targets);
    expect(bot.command.mock.calls.filter(([name]) => name === "schedule")).toHaveLength(1);
    await required(commands.get("schedule"))(context({ text: "/schedule" }));
    const text = context({ text: "queued later", replyToMessageId: 1001 });
    await required(events.get("message:text"))(text);
    const callback = context({
      callbackData: required(
        buttons(text).find((b) => b.text === scheduleMessages("telegram").in30m),
      ).callback_data,
    });
    await required(events.get("callback_query:data"))(callback);
    expect(buttons(callback).some((b) => b.text === scheduleMessages("telegram").confirm)).toBe(
      true,
    );
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(scheduler.create).not.toHaveBeenCalled();
  });
  it("selects a target from the shared picker without switching the chat", async () => {
    const beta = {
      ...target,
      sessionName: "project_beta",
      label: "Beta",
      incarnation: "generation-2",
    };
    vi.spyOn(picker, "projectPickerRows").mockResolvedValue([
      { sessionName: beta.sessionName, sid: "abcdef", label: beta.label, alive: true },
    ] as Awaited<ReturnType<typeof picker.projectPickerRows>>);
    vi.spyOn(projectOperations, "resolveAliveSessionByShortId").mockResolvedValue(beta.sessionName);
    scheduler.captureTarget.mockResolvedValue(beta);
    const draft = memory.create(owner, target);
    const choose = await click(scheduleCallbackData("targets", draft.id, draft.revision));
    await click(required(buttons(choose).find((b) => b.text === beta.label)).callback_data);
    expect(memory.get(owner, draft.id)?.target).toEqual(beta);
    expect(deps.currentProject.set).not.toHaveBeenCalled();
  });
});

it("refuses a stale control-panel target instead of redirecting to the current chat", async () => {
  vi.spyOn(projectOperations, "resolveAliveSessionByShortId").mockResolvedValue(null);
  const ctx = await click(scheduleCallbackData("new", "abcdef"));
  expect(ctx.texts().join()).toContain(scheduleMessages("telegram").invalidTarget);
  expect(scheduler.captureTarget).not.toHaveBeenCalled();
});

describe("restart-safe dedicated prompt isolation", () => {
  it.each(Object.entries(scheduledMessageCatalogs))(
    "consumes old %s bot prompt replies after all draft state is lost",
    async (_locale, catalog) => {
      // A fresh module has neither draft entries nor adapter prompt tombstones.
      vi.resetModules();
      const restarted = await import("../../../src/adapters/telegram/scheduled-messages.js");
      for (const prompt of [catalog.enterText, catalog.enterTime]) {
        const ctx = context({
          text: "Keep this instruction scheduled only",
          replyToMessageId: 908172,
        });
        Object.assign(ctx, {
          me: { id: 42 },
          message: {
            ...ctx.message,
            reply_to_message: {
              message_id: 908172,
              from: { id: 42, is_bot: true },
              text: `${prompt}\n📂 Earlier target`,
            },
          },
        });
        expect(await restarted.handleScheduleReply(ctx, targets)).toBe(true);
        expect(ctx.texts().join()).toContain(scheduleMessages("telegram").expired);
        expect(scheduler.create).not.toHaveBeenCalled();
        expect(deps.queue.enqueue).not.toHaveBeenCalled();
      }
    },
  );
  it("recognizes only this bot's exact prompt headers", async () => {
    const prompt = scheduledMessageCatalogs.en.enterText;
    for (const [id, isBot, text] of [
      [99, true, prompt],
      [42, false, prompt],
      [42, true, `Quoted text: ${prompt}`],
    ] as const) {
      const ctx = context({ text: "ordinary reply", replyToMessageId: 908173 });
      Object.assign(ctx, {
        me: { id: 42 },
        message: {
          ...ctx.message,
          reply_to_message: { message_id: 908173, from: { id, is_bot: isBot }, text },
        },
      });
      expect(await handleScheduleReply(ctx, targets)).toBe(false);
    }
  });
});

it("uses a short label for the exact-time input button", async () => {
  const draft = memory.update(owner, memory.create(owner, target).id, { text: "body" });
  const menu = await click(scheduleCallbackData("time", draft.id, draft.revision));
  const typed = required(buttons(menu).find((button) => button.callback_data.includes(":typed:")));
  expect(typed.text).not.toBe(scheduleMessages("telegram").enterTime);
  expect(typed.text).toBeTruthy();
  expect(typed.text.length).toBeLessThan(40);
});

it("reviews explicit-offset times in their saved timezone when the host uses UTC", async () => {
  vi.stubEnv("TZ", "UTC");
  vi.stubEnv("TELEGRAM_UI_LANG", "en");
  // Explicitly emulate UTC defaults: changing TZ at runtime is host-dependent.
  const originalLocaleString = Date.prototype.toLocaleString;
  vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
    this: Date,
    locales,
    options,
  ) {
    return originalLocaleString.call(this, locales, { timeZone: "UTC", ...options });
  });
  try {
    const draft = memory.update(owner, memory.create(owner, target).id, {
      text: "body",
      when: { dueAt: Date.parse("2099-01-01T09:00+08:00"), timezone: "UTC+08:00" },
    });
    const review = await click(scheduleCallbackData("review", draft.id, draft.revision));
    expect(review.texts().join()).toMatch(/0?9:00/);
    expect(review.texts().join()).toContain("UTC+08:00");
  } finally {
    vi.unstubAllEnvs();
  }
});
