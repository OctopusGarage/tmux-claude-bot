import type { Bot, Context } from "grammy";
import type { ReplyTargetMap } from "../services/reply-target.js";
import { getPathBySession } from "../services/sessionPathMap.js";
import { normalizeError } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";
import { timeApi } from "../utils/timing.js";
import { codeBlockV2, escapeMarkdownV2, stripMarkdownV2, toTelegramMarkdown } from "./markdown.js";
import { projectLabel } from "./project-label.js";

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
const TRUNCATION_NOTICE = "\n…(内容过长，已截断)";

export function composeMessage(tone: Tone, head: string, opts: ReplyOpts = {}): Composed {
  return compose(tone, head, opts);
}

function compose(tone: Tone, head: string, opts: ReplyOpts): Composed {
  const emoji = TONE_EMOJI[tone];
  // Line 1: "<emoji> <head> · ⏱ Ns"
  let statusLine = [emoji, head].filter(Boolean).join(" ");
  if (opts.elapsedS !== undefined) {
    const elapsed = `⏱ ${opts.elapsedS}s`;
    statusLine = statusLine ? `${statusLine} · ${elapsed}` : elapsed;
  }
  // Line 2: "📂 <friendly project name>"
  const projectLine = opts.session
    ? `📂 ${projectLabel(opts.session, getPathBySession(opts.session) ?? undefined)}`
    : "";
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
    const budget = TELEGRAM_MAX_LEN - header.length - 2 - TRUNCATION_NOTICE.length;
    const plainBody = opts.body.slice(0, Math.max(0, budget)) + TRUNCATION_NOTICE;
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

export async function reply(
  ctx: Context,
  tone: Tone,
  head: string,
  opts: ReplyOpts = {},
): Promise<void> {
  const { text, extra } = compose(tone, head, opts);
  const chatId = ctx.chat?.id ?? "unknown";
  const replyTo = opts.replyTo ?? ctx.message?.message_id;
  const msgId = replyTo ?? "none";
  const sendExtra = replyTo !== undefined ? { ...extra, reply_to_message_id: replyTo } : extra;

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sentMsg = await timeApi("reply", () => ctx.reply(text, sendExtra));
      const telegramMsgId =
        "message_id" in sentMsg ? (sentMsg as { message_id: number }).message_id : null;
      logger.info(
        `[replies] sent to chat=${chatId} replyTo=${msgId} telegramMsgId=${telegramMsgId} len=${text.length}`,
      );
      if (telegramMsgId !== null && opts.replyTarget && opts.session) {
        opts.replyTarget.record(telegramMsgId, opts.session);
      }
      return;
    } catch (err) {
      const desc = describe(err);

      // Retry on transient network errors
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        logger.warn(
          `[replies] network error on attempt ${attempt}/${MAX_RETRIES}, retrying in 1s: ${desc}`,
        );
        await sleep(1000);
        continue;
      }

      // If Markdown parse failed (error_code 400), retry without parse_mode so user still gets the content
      const isParseError =
        (opts.code || opts.markdown) &&
        err !== null &&
        typeof err === "object" &&
        (err as Record<string, unknown>).error_code === 400 &&
        typeof (err as Record<string, unknown>).description === "string" &&
        String((err as Record<string, unknown>).description).includes("can't parse");
      if (isParseError) {
        logger.warn(
          `[replies] Markdown parse failed for chat=${chatId}, retrying without parse_mode`,
        );
        const fallbackExtra = { ...sendExtra };
        delete fallbackExtra.parse_mode;
        // Strip the MarkdownV2 markup so the fallback shows clean text.
        const plain = stripMarkdownV2(text);
        try {
          await timeApi("reply(fallback)", () => ctx.reply(plain, fallbackExtra));
          logger.info(`[replies] fallback sent to chat=${chatId} replyTo=${msgId}`);
          return;
        } catch (fallbackErr) {
          logger.error(`[replies] fallback reply failed ${describe(fallbackErr)} chat=${chatId}`);
        }
      }

      logger.error(
        `[replies] reply failed ${desc} chat=${chatId} replyTo=${msgId} text_len=${text.length}`,
      );
      return;
    }
  }
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

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sentMsg = await timeApi("send", () => bot.api.sendMessage(chatId, text, sendExtra));
      const telegramMsgId =
        "message_id" in sentMsg ? (sentMsg as { message_id: number }).message_id : null;
      if (telegramMsgId !== null && opts.replyTarget && opts.session) {
        opts.replyTarget.record(telegramMsgId, opts.session);
      }
      return;
    } catch (err) {
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        logger.warn(
          `[replies] send network error on attempt ${attempt}/${MAX_RETRIES}, retrying in 1s: ${describe(err)}`,
        );
        await sleep(1000);
        continue;
      }
      logger.error(`[replies] send failed ${describe(err)}`);
      return;
    }
  }
}
