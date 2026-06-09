import { logger } from "../utils/logger.js";
import { timeApi } from "../utils/timing.js";

export interface ProgressApi {
  sendMessage(
    chatId: number,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ProgressHandle {
  /** Telegram id of the live progress message. */
  readonly messageId: number;
  /** Edit the progress message in place (e.g. to show elapsed time). */
  update(text: string): Promise<void>;
  /**
   * Edit the progress message into its final form. Returns whether the edit
   * ultimately landed, so the caller can fall back to a fresh reply if the
   * progress message could not be updated.
   */
  finalize(text: string, extra?: Record<string, unknown>): Promise<boolean>;
}

function isMarkdownParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e.error_code === 400 &&
    typeof e.description === "string" &&
    e.description.includes("can't parse")
  );
}

/**
 * Send a single "live" message that is later edited in place — first into
 * progress ticks, then into the final result. This gives the chat a sense of
 * the task transforming under your eyes instead of going silent then dumping a
 * wall of text.
 *
 * Returns null if the initial send fails, so the caller can fall back to a
 * plain reply rather than losing the response entirely.
 */
export async function startProgress(
  api: ProgressApi,
  chatId: number,
  initialText: string,
  extra?: Record<string, unknown>,
): Promise<ProgressHandle | null> {
  let sent: { message_id: number };
  try {
    sent = await timeApi("sendMessage(progress)", () =>
      api.sendMessage(chatId, initialText, extra ?? {}),
    );
  } catch (err) {
    logger.warn(
      `[progress] failed to send initial message chat=${chatId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  const messageId = sent.message_id;

  const update = async (text: string): Promise<void> => {
    try {
      await timeApi("editMessageText(tick)", () => api.editMessageText(chatId, messageId, text));
    } catch (err) {
      logger.warn(
        `[progress] failed to edit chat=${chatId} msg=${messageId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  const finalize = async (
    text: string,
    finalizeExtra?: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      await timeApi("editMessageText(final)", () =>
        api.editMessageText(chatId, messageId, text, finalizeExtra),
      );
      return true;
    } catch (err) {
      // Mirror the reply() path: if Markdown parsing fails, retry as plain text
      // so the result still lands instead of the message staying stuck.
      if (isMarkdownParseError(err) && finalizeExtra?.parse_mode) {
        const { parse_mode: _drop, ...rest } = finalizeExtra;
        try {
          await timeApi("editMessageText(final,plain)", () =>
            api.editMessageText(chatId, messageId, text, rest),
          );
          return true;
        } catch (fallbackErr) {
          logger.warn(
            `[progress] finalize fallback failed chat=${chatId} msg=${messageId}: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
          );
          return false;
        }
      }
      logger.warn(
        `[progress] finalize failed chat=${chatId} msg=${messageId}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  };

  return { messageId, update, finalize };
}
