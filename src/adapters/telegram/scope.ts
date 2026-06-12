import type { Context } from "grammy";
import { chatScope } from "../../core/project-manager.js";

/** The current-project scope key for a Telegram update — `chatScope("telegram", <chat id>)`.
 *  Centralizes the `String(ctx.chat?.id ?? 0)` dance every handler was repeating. */
export function tgScope(ctx: Context): string {
  return chatScope("telegram", String(ctx.chat?.id ?? 0));
}
