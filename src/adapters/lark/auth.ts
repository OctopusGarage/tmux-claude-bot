/**
 * Drop messages from non-allowlisted Lark users. Empty allowlist = reject all
 * (mirrors the Telegram auth guard: an unconfigured bot serves nobody).
 */
export function isOpenIdAllowed(openId: string, allowed: Set<string>): boolean {
  if (!openId) return false;
  return allowed.size > 0 && allowed.has(openId);
}
