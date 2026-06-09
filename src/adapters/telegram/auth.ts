import type { Context, NextFunction } from "grammy";
import { logger } from "../../shared/utils/logger.js";

/**
 * Whitelist check. Fails CLOSED: an empty allowlist rejects everyone, matching
 * the contract documented in `scripts/setup.ts` ("the bot will reject ALL
 * messages until you set it"). The bot drives Claude with skipped permissions,
 * so an unconfigured allowlist must never default to open.
 */
export function isAuthorized(userId: number | undefined, allowedIds: Set<string>): boolean {
  if (allowedIds.size === 0) return false;
  if (userId === undefined) return false;
  return allowedIds.has(String(userId));
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
    logger.warn(
      `[auth] rejected unauthorized update from user=${ctx.from?.id ?? "unknown"} chat=${ctx.chat?.id ?? "unknown"}`,
    );
  };
}
