import type { Context, NextFunction } from "grammy";
import { isAllowListed } from "../../core/infra/allow-list.js";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("telegram.auth");

/**
 * Whitelist check for a Telegram user id. Defers the fail-CLOSED rule to the
 * shared {@link isAllowListed} (empty allowlist rejects all); this wrapper owns
 * only the Telegram-specific number -> string coercion.
 */
export function isAuthorized(userId: number | undefined, allowedIds: Set<string>): boolean {
  return isAllowListed(userId === undefined ? undefined : String(userId), allowedIds);
}

/**
 * grammy middleware that drops updates from unauthorized users before any
 * handler runs. Unauthorized senders get silence (no reply) to avoid leaking
 * the bot's existence/behavior to probers.
 */
export function createAuthGuard(allowedIds: Set<string>) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (isAuthorized(ctx.from?.id, allowedIds)) {
      await next();
      return;
    }
    log.warn(
      `rejected unauthorized update from user=${ctx.from?.id ?? "unknown"} chat=${ctx.chat?.id ?? "unknown"}`,
    );
  };
}
