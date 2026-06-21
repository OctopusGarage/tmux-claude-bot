import { isAllowListed } from "../../core/infra/allow-list.js";

/**
 * Drop messages from non-allowlisted Lark users. Defers the fail-CLOSED rule to
 * the shared {@link isAllowListed} (empty allowlist = reject all), so Telegram
 * and Lark cannot drift on the security-critical invariant.
 */
export function isOpenIdAllowed(openId: string, allowed: Set<string>): boolean {
  return isAllowListed(openId, allowed);
}
