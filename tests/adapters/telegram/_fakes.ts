import type { Bot, Context } from "grammy";
import { vi } from "vitest";
import { fakeDeps as larkFakeDeps } from "../lark/_fakes.js";

/**
 * Shared fakes for the Telegram adapter orchestration tests. They record the
 * observable outputs of a grammy `Context` — every `ctx.reply` / api call — so
 * tests can assert which text/markup went out and which callbacks were answered,
 * not implementation details.
 *
 * The bot's text replies funnel through `ctx.reply` (and `bot.api.sendMessage`
 * for the `send` helper), so recording those is enough: inspect the recorded
 * `text` / `reply_markup` to tell replies apart.
 *
 * `fakeDeps` reuses the Lark `HandlerDeps` fake (the bundle is protocol-agnostic)
 * and patches in the bridge methods the Telegram paths additionally reach
 * (`isPaneAlive`) plus the persisted-queue hooks (`loadPersisted` /
 * `clearPersisted`).
 */

export { fakeChannel } from "../lark/_fakes.js";

export type ReplyRecord = {
  text: string;
  extra: Record<string, unknown>;
};

export type FakeCtx = Context & {
  /** Every `ctx.reply(text, extra)` call. */
  replies: ReplyRecord[];
  /** The text of every reply, for quick `.some(...)` assertions. */
  texts: () => string[];
  /** Every `editMessageReplyMarkup` payload. */
  editedMarkups: unknown[];
  /** Every `answerCallbackQuery` text (undefined when answered with no toast). */
  answered: (string | undefined)[];
};

type CtxOverrides = {
  chatId?: number;
  messageId?: number;
  text?: string;
  /** message.reply_to_message.message_id — exercises reply-target resolution. */
  replyToMessageId?: number;
  /** callbackQuery.data — for handleCallbackQuery tests. */
  callbackData?: string;
};

export function fakeCtx(overrides: CtxOverrides = {}): FakeCtx {
  const chatId = overrides.chatId ?? 100;
  const messageId = overrides.messageId ?? 1;

  const replies: ReplyRecord[] = [];
  const editedMarkups: unknown[] = [];
  const answered: (string | undefined)[] = [];
  let n = 0;

  const message: Record<string, unknown> = { message_id: messageId };
  if (overrides.text !== undefined) message.text = overrides.text;
  if (overrides.replyToMessageId !== undefined) {
    message.reply_to_message = { message_id: overrides.replyToMessageId };
  }

  const callbackQuery =
    overrides.callbackData !== undefined ? { id: "cb1", data: overrides.callbackData } : undefined;

  const ctx = {
    chat: { id: chatId },
    message,
    callbackQuery,
    replies,
    editedMarkups,
    answered,
    texts: () => replies.map((r) => r.text),
    reply: vi.fn(async (text: string, extra: Record<string, unknown> = {}) => {
      replies.push({ text, extra });
      n += 1;
      return { message_id: 1000 + n };
    }),
    editMessageReplyMarkup: vi.fn(async (payload: unknown) => {
      editedMarkups.push(payload);
      return true;
    }),
    answerCallbackQuery: vi.fn(async (other?: { text?: string }) => {
      answered.push(other?.text);
      return true;
    }),
  } as unknown as FakeCtx;

  return ctx;
}

export type SentRecord = {
  chatId: number;
  text: string;
  extra: Record<string, unknown>;
};

export type FakeBot = Bot & {
  sent: SentRecord[];
  texts: () => string[];
};

/** A grammy `Bot` whose `api.sendMessage` records its calls (for `send`/restore). */
export function fakeBot(): FakeBot {
  const sent: SentRecord[] = [];
  let n = 0;
  const bot = {
    sent,
    texts: () => sent.map((s) => s.text),
    api: {
      sendMessage: vi.fn(
        async (chatId: number, text: string, extra: Record<string, unknown> = {}) => {
          sent.push({ chatId, text, extra });
          n += 1;
          return { message_id: 2000 + n };
        },
      ),
    },
  } as unknown as FakeBot;
  return bot;
}

type DepsOverrides = Parameters<typeof larkFakeDeps>[0] & {
  /** bridge.isPaneAlive return value (default true). */
  paneAlive?: boolean;
  /** queue.loadPersisted return value (default []). */
  persisted?: unknown[];
};

export type FakeDeps = ReturnType<typeof larkFakeDeps>;

/**
 * The shared `HandlerDeps` fake, extended for the Telegram paths: a default
 * `isPaneAlive` on the bridge (consulted by `requireSession`) and
 * `loadPersisted`/`clearPersisted` on the queue (used by the restore filter).
 */
export function fakeDeps(overrides: DepsOverrides = {}): FakeDeps {
  const { paneAlive, persisted, ...rest } = overrides;
  const deps = larkFakeDeps(rest);

  const bridge = deps.bridge as unknown as Record<string, unknown>;
  if (rest.bridge?.isPaneAlive === undefined) {
    bridge.isPaneAlive = vi.fn(async () => paneAlive ?? true);
  }
  // Telegram's requireSession gates on hasSession; default it alive (the shared
  // Lark fake defaults it false) so the current project resolves out of the box.
  if (rest.bridge?.hasSession === undefined) {
    bridge.hasSession = vi.fn(async () => true);
  }

  const queue = deps.queue as unknown as Record<string, unknown>;
  if (rest.queue?.loadPersisted === undefined) {
    queue.loadPersisted = vi.fn(() => persisted ?? []);
  }
  if (rest.queue?.clearPersisted === undefined) {
    queue.clearPersisted = vi.fn();
  }

  return deps;
}
