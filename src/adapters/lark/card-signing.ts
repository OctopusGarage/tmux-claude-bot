import { createHmac } from "node:crypto";

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

/** Attach an HMAC signature to a card button value. No-op when no secret is configured. */
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
  return sig === expected;
}
