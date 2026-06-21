/**
 * The single home for the bot's fail-CLOSED authorization rule, shared by every
 * adapter (Telegram user ids, Lark open ids, …).
 *
 * Fails CLOSED on purpose: an EMPTY allowlist rejects everyone, and a missing id
 * is rejected. The bot drives an agent with skipped permissions, so an
 * unconfigured allowlist must never default to open. Each adapter coerces its
 * native id to a string and calls this — keeping the security invariant in one
 * place rather than re-implemented per platform.
 */
export function isAllowListed(id: string | undefined, allowed: Set<string>): boolean {
  if (allowed.size === 0) return false;
  if (!id) return false;
  return allowed.has(id);
}
