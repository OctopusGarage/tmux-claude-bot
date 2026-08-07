import type { LarkChannel, SendResult } from "@larksuiteoapi/node-sdk";
import { messages } from "../../core/i18n/index.js";
import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import { tidyFloatNoise, tidyFloatNoiseDeep } from "../../shared/utils/number.js";
import { tildeifyHome, tildeifyHomeDeep } from "../../shared/utils/path.js";
import { sleep } from "../../shared/utils/sleep.js";
import { textOrPlaceholder } from "./format.js";

const log = createLogger("lark.replies");

const MAX_SEND_ATTEMPTS = 3;
/**
 * `channel.send` rejects with a `LarkChannelError` carrying a fixed-vocabulary
 * `code` (the SDK wraps raw network/axios errors into these). The SDK ALREADY
 * retries `rate_limited` / `unknown` internally and only surfaces them once
 * exhausted — re-retrying those here would just hammer a live rate limit. It
 * deliberately passes the transient ones below straight through, so THIS layer is
 * where they get a second chance:
 *  - `send_timeout`: the response timed out;
 *  - `not_connected`: the WS was momentarily down — a short backoff may let the
 *    keepalive reconnect.
 * Everything else (`format_error` / `target_revoked` / `permission_denied` /
 * `upload_failed` / `ssrf_blocked`) is permanent — fail fast.
 */
const RETRYABLE_CODES = new Set(["send_timeout", "not_connected"]);

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

/**
 * Send through the Lark channel with up to {@link MAX_SEND_ATTEMPTS} attempts,
 * retrying only the SDK-passthrough transient codes ({@link isRetryable}) with linear
 * backoff. Best-effort: an exhausted/non-retryable failure is logged and swallowed
 * (returns undefined) so it can't bubble into the channel's message handler.
 *
 * TRADEOFF (at-least-once): `channel.send` carries no outbound idempotency key, so a
 * send that reached Feishu but timed out on the response is re-posted — a rare
 * duplicate (and, for a long reply the SDK split into chunks, a re-post of the
 * already-delivered chunks). Preferred over silently dropping the reply — the same
 * tradeoff the Telegram path and the SDK's own retry already make. (Exactly-once
 * would need im.v1.message.create with a client `uuid`, bypassing the channel.)
 */
async function sendWithRetry(
  label: string,
  send: () => Promise<SendResult>,
): Promise<SendResult | undefined> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_SEND_ATTEMPTS && isRetryable(err)) {
        log.warn(
          `${label} transient error (attempt ${attempt}/${MAX_SEND_ATTEMPTS}), retrying: ${normalizeError(err).message}`,
        );
        await sleep(attempt * 600); // linear backoff: 600ms, 1200ms
        continue;
      }
      break;
    }
  }
  log.error(`${label} failed`, { err: lastErr });
  return undefined;
}

/** Send a plain text/markdown reply. Never throws — failures are retried (transient)
 * then logged and swallowed so they cannot bubble into the channel's message handler. */
export async function sendText(
  channel: LarkChannel,
  chatId: string,
  output: string,
): Promise<void> {
  // Send-boundary chokepoint: shorten home paths to `~` + collapse float-display
  // noise for every user-facing reply (see CLAUDE.md "User-facing paths").
  const markdown = textOrPlaceholder(tildeifyHome(tidyFloatNoise(output)));
  await sendWithRetry(`sendText chat=${chatId}`, () => channel.send(chatId, { markdown }));
}

/** Send a normalized "Error: <msg>" reply — the one place the Lark view handlers'
 * catch blocks funnel through, in the channel's language. */
export async function sendError(channel: LarkChannel, chatId: string, err: unknown): Promise<void> {
  await sendText(channel, chatId, messages("lark").errorPrefix(normalizeError(err).message));
}

/** Send an interactive card reply, returning the sent message id so the card can
 * later be updated. Best-effort: failures are logged and swallowed. */
export async function sendCard(
  channel: LarkChannel,
  chatId: string,
  card: object,
): Promise<string | undefined> {
  // Shorten home paths to `~` in every string of the card (send-boundary
  // chokepoint — see CLAUDE.md "User-facing paths").
  const safeCard = tildeifyHomeDeep(tidyFloatNoiseDeep(card));
  const r = await sendWithRetry(`sendCard chat=${chatId}`, () =>
    channel.send(chatId, { card: safeCard }),
  );
  return r?.messageId;
}
