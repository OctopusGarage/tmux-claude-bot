import type { Bot, Context } from "grammy";
import { messages } from "../../core/i18n/index.js";
import { labelForSession } from "../../core/projects/project-label.js";
import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import { tidyFloatNoise } from "../../shared/utils/number.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import { sleep } from "../../shared/utils/sleep.js";
import { timeApi } from "../../shared/utils/timing.js";
import { codeBlockV2, escapeMarkdownV2, stripMarkdownV2, toTelegramMarkdown } from "./markdown.js";
import type { ReplyTargetMap } from "./reply-target.js";

const log = createLogger("telegram.replies");

export type Tone =
  | "ok"
  | "result"
  | "err"
  | "warn"
  | "info"
  | "queue"
  | "queued"
  | "list"
  | "view"
  | "recover"
  | "help";

const TONE_EMOJI: Record<Tone, string> = {
  ok: "✅",
  result: "🤖",
  err: "❌",
  warn: "⚠️",
  queue: "📋",
  queued: "⏳",
  list: "📁",
  view: "👁",
  recover: "🔄",
  info: "",
  help: "",
};

export interface ReplyOpts {
  session?: string | undefined;
  body?: string | undefined;
  code?: boolean | undefined;
  /**
   * Render the body as Markdown prose (no code fence) — for Claude's
   * natural-language answers, which read far better than forced monospace.
   * Ignored when `code` is set. Falls back to plain text if Markdown parsing
   * fails (handled in the send loop).
   */
  markdown?: boolean | undefined;
  replyTo?: number | undefined;
  replyTarget?: ReplyTargetMap | undefined;
  /** Inline keyboard (or other reply markup) to attach to the message. */
  replyMarkup?: unknown | undefined;
  /** When set, append ` · ⏱ Ns` to the status line (elapsed seconds). */
  elapsedS?: number | undefined;
}

interface Composed {
  text: string;
  extra: Record<string, unknown>;
}

// Telegram rejects messages over 4096 chars with a 400 that has no parse-error
// fallback, so an over-limit reply is silently dropped. Cap the body below the
// hard limit (leaving room for the head line and code-block fence) so every
// reply path degrades to a truncated message instead of no message at all.
const TELEGRAM_MAX_LEN = 4096;

export function composeMessage(tone: Tone, head: string, opts: ReplyOpts = {}): Composed {
  return compose(tone, head, opts);
}

/** Build the message, then run it through the send-boundary chokepoints: shorten
 * home paths to `~` and collapse floating-point display noise (see CLAUDE.md
 * "User-facing paths"). Call sites never have to remember either. */
function compose(tone: Tone, head: string, opts: ReplyOpts): Composed {
  const { text, extra } = composeRaw(tone, head, opts);
  return { text: tildeifyHome(tidyFloatNoise(text)), extra };
}

function composeRaw(tone: Tone, head: string, opts: ReplyOpts): Composed {
  const emoji = TONE_EMOJI[tone];
  // Line 1: "<emoji> <head> · ⏱ Ns"
  let statusLine = [emoji, head].filter(Boolean).join(" ");
  if (opts.elapsedS !== undefined) {
    const elapsed = `⏱ ${opts.elapsedS}s`;
    statusLine = statusLine ? `${statusLine} · ${elapsed}` : elapsed;
  }
  // Line 2: "📂 <friendly project name>"
  const projectLine = opts.session ? `📂 ${labelForSession(opts.session)}` : "";
  const header = [statusLine, projectLine].filter(Boolean).join("\n");

  // Messages with a formatted body render as Telegram MarkdownV2 (via
  // telegramify-markdown): terminal output as a code block, Claude's markdown
  // converted. Plain bodies and bare status lines stay as-is (no parse_mode).
  const useFmt = Boolean(opts.code || opts.markdown);
  const extra: Record<string, unknown> = {};
  if (opts.replyMarkup) extra.reply_markup = opts.replyMarkup;

  if (!opts.body) {
    return { text: useFmt ? escapeMarkdownV2(header) : header, extra };
  }

  const renderBody = (): string =>
    opts.code ? codeBlockV2(opts.body ?? "") : toTelegramMarkdown(opts.body ?? "");
  const safeHeader = useFmt ? escapeMarkdownV2(header) : header;
  const join = (h: string, b: string): string => (h ? `${h}\n\n${b}` : b);

  const text = useFmt ? join(safeHeader, renderBody()) : join(header, opts.body);

  // Oversized after rendering → drop formatting, send plain + truncated so the
  // message still goes through (Telegram silently drops messages over 4096).
  if (text.length > TELEGRAM_MAX_LEN) {
    const truncationNotice = `\n${messages("telegram").contentTruncated}`;
    const budget = TELEGRAM_MAX_LEN - header.length - 2 - truncationNotice.length;
    const plainBody = opts.body.slice(0, Math.max(0, budget)) + truncationNotice;
    return { text: join(header, plainBody), extra };
  }

  if (useFmt) extra.parse_mode = "MarkdownV2";
  return { text, extra };
}

function isRetryableError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e.error_code === 429) return true;
    const cause = e.error;
    if (cause && typeof cause === "object") {
      const code = (cause as Record<string, unknown>).code;
      const retryableCodes = [
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "EPIPE",
        "ENOTFOUND",
        "EAI_AGAIN",
      ];
      if (typeof code === "string" && retryableCodes.includes(code)) return true;
    }
  }
  return false;
}

/** Backoff before a retry — honor Telegram's 429 `retry_after`, else 1s. Retrying
 * a rate-limit after a flat 1s just earns another 429 and burns the attempt. */
function retryDelayMs(err: unknown): number {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const params = e.parameters as Record<string, unknown> | undefined;
    if (e.error_code === 429 && typeof params?.retry_after === "number") {
      return Math.max(1000, params.retry_after * 1000);
    }
  }
  return 1000;
}

function describe(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const errorCode = e.error_code;
    const description = e.description;
    if (typeof errorCode === "number" && typeof description === "string") {
      const params = e.parameters as Record<string, unknown> | undefined;
      const retry =
        typeof params?.retry_after === "number" ? ` retry_after=${params.retry_after}s` : "";
      return `[${errorCode}] ${description}${retry}`;
    }
    const cause = e.error;
    if (cause && typeof cause === "object") {
      const c = cause as Record<string, unknown>;
      const code = c.code ?? c.errno ?? e.code ?? "unknown";
      const reason = String(c.message ?? normalizeError(err).message).replace(
        /\/bot[^/]+\//g,
        "/bot***/",
      );
      return `[${code}] ${reason}`;
    }
  }
  return `[unknown] ${normalizeError(err).message}`;
}

/** The telegram message id of a send result, or null when absent. */
function messageIdOf(sentMsg: unknown): number | null {
  return sentMsg && typeof sentMsg === "object" && "message_id" in sentMsg
    ? (sentMsg as { message_id: number }).message_id
    : null;
}

/**
 * Send with up to 3 attempts, retrying only transient network / rate-limit
 * errors (with backoff). `onSent` records the result on success; `onFinalError`
 * handles a non-retryable error or exhausted retries (its own logging and any
 * fallback). Shared by {@link reply} and {@link send}.
 */
async function withSendRetry(
  label: string,
  attempt: () => Promise<unknown>,
  onSent: (sentMsg: unknown) => void,
  onFinalError: (err: unknown) => Promise<void>,
): Promise<void> {
  const MAX_RETRIES = 3;
  for (let n = 1; n <= MAX_RETRIES; n++) {
    try {
      onSent(await timeApi(label, attempt));
      return;
    } catch (err) {
      if (isRetryableError(err) && n < MAX_RETRIES) {
        log.warn(
          `${label} network error on attempt ${n}/${MAX_RETRIES}, retrying in 1s: ${describe(err)}`,
        );
        await sleep(retryDelayMs(err));
        continue;
      }
      await onFinalError(err);
      return;
    }
  }
}

export async function reply(
  ctx: Context,
  tone: Tone,
  head: string,
  opts: ReplyOpts = {},
): Promise<number | null> {
  const { text, extra } = compose(tone, head, opts);
  const chatId = ctx.chat?.id ?? "unknown";
  const replyTo = opts.replyTo ?? ctx.message?.message_id;
  const msgId = replyTo ?? "none";
  const sendExtra = replyTo !== undefined ? { ...extra, reply_to_message_id: replyTo } : extra;

  // The sent message's id, so callers can map an ack to what it acked (e.g. bind a
  // queued-message ack to its queue item for reply-to-replace). null on a fallback
  // send or a final failure.
  let sentId: number | null = null;
  await withSendRetry(
    "reply",
    () => ctx.reply(text, sendExtra),
    (sentMsg) => {
      const telegramMsgId = messageIdOf(sentMsg);
      sentId = telegramMsgId;
      log.info(
        `sent to chat=${chatId} replyTo=${msgId} telegramMsgId=${telegramMsgId} len=${text.length}`,
      );
      if (telegramMsgId !== null && opts.replyTarget && opts.session) {
        opts.replyTarget.record(telegramMsgId, opts.session);
      }
    },
    async (err) => {
      // If Markdown parse failed (error_code 400), retry without parse_mode so
      // the user still gets the content.
      const isParseError =
        (opts.code || opts.markdown) &&
        err !== null &&
        typeof err === "object" &&
        (err as Record<string, unknown>).error_code === 400 &&
        typeof (err as Record<string, unknown>).description === "string" &&
        String((err as Record<string, unknown>).description).includes("can't parse");
      if (isParseError) {
        log.warn(`Markdown parse failed for chat=${chatId}, retrying without parse_mode`);
        const fallbackExtra = { ...sendExtra };
        delete fallbackExtra.parse_mode;
        // Strip the MarkdownV2 markup so the fallback shows clean text.
        const plain = stripMarkdownV2(text);
        try {
          await timeApi("reply(fallback)", () => ctx.reply(plain, fallbackExtra));
          log.info(`fallback sent to chat=${chatId} replyTo=${msgId}`);
          return;
        } catch (fallbackErr) {
          log.error(`fallback reply failed ${describe(fallbackErr)} chat=${chatId}`);
        }
      }
      log.error(
        `reply failed ${describe(err)} chat=${chatId} replyTo=${msgId} text_len=${text.length}`,
      );
    },
  );
  return sentId;
}

export async function send(
  bot: Bot,
  chatId: number,
  tone: Tone,
  head: string,
  opts: ReplyOpts = {},
): Promise<void> {
  const { text, extra } = compose(tone, head, opts);
  const sendExtra =
    opts.replyTo !== undefined ? { ...extra, reply_to_message_id: opts.replyTo } : extra;

  await withSendRetry(
    "send",
    () => bot.api.sendMessage(chatId, text, sendExtra),
    (sentMsg) => {
      const telegramMsgId = messageIdOf(sentMsg);
      if (telegramMsgId !== null && opts.replyTarget && opts.session) {
        opts.replyTarget.record(telegramMsgId, opts.session);
      }
    },
    async (err) => {
      log.error(`send failed ${describe(err)}`);
    },
  );
}
