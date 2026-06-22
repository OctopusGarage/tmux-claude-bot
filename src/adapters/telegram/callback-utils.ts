import { createLogger } from "../../shared/utils/logger.js";
import { timeApi } from "../../shared/utils/timing.js";

const log = createLogger("telegram.callback-utils");

export interface AnswerableCtx {
  answerCallbackQuery(other?: { text?: string }): Promise<unknown>;
}

/**
 * Answer an inline-button callback, swallowing failures. Answering only stops
 * the button's loading spinner / shows a toast — a transient network error here
 * must never propagate, or (without a bot.catch) it would crash the process and
 * the unconfirmed update would be redelivered in a crash loop.
 */
export async function safeAnswerCallback(ctx: AnswerableCtx, text?: string): Promise<void> {
  try {
    await timeApi("answerCallbackQuery", () =>
      ctx.answerCallbackQuery(text !== undefined ? { text } : undefined),
    );
  } catch (err) {
    log.warn("answerCallbackQuery failed", { err });
  }
}
