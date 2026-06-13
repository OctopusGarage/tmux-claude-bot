import { createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string | undefined {
  return process.env.CARD_SIGNING_SECRET || process.env.LARK_APP_SECRET || undefined;
}

function canonicalize(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj)
    .filter((k) => k !== "_sig")
    .sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/**
 * Attach an HMAC signature to a card button value. No-op when no secret is configured.
 *
 * SCOPE (intentional): the signature covers ONLY the static button payload
 * (cmd/sid/idx/lang) — its job is integrity, i.e. a client cannot forge a value
 * it was never offered. It deliberately does NOT bind a timestamp or chatId:
 *  - A timestamp/expiry would break legitimate LATE clicks (an hour-old result
 *    card's button should still work).
 *  - chatId binding would have to be threaded through every card builder for
 *    marginal gain: in this single-owner model (open_id allowlist + chat-policy
 *    gate) a replay is not a privilege escalation — every allowed clicker is the
 *    owner. HMAC integrity + allowlist + policy gate already cover the threat.
 * Considered and rejected; don't add replay/time/chat binding without a concrete
 * multi-tenant threat that the allowlist doesn't already handle.
 */
export function signValue(value: object): object {
  const secret = getSecret();
  if (!secret) return value;
  const body = canonicalize(value as Record<string, unknown>);
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return { ...(value as Record<string, unknown>), _sig: sig };
}

/**
 * Verify the HMAC signature on an incoming card callback value.
 * Returns true when no secret is configured (signing disabled).
 */
export function verifyValue(value: unknown): boolean {
  const secret = getSecret();
  if (!secret) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const sig = v._sig;
  if (typeof sig !== "string") return false;
  const body = canonicalize(v);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  // Constant-time compare so the time taken can't leak how many leading chars of
  // a forged _sig were correct (a timing oracle for forging signatures). Lengths
  // must match first — timingSafeEqual throws on a length mismatch.
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
}
