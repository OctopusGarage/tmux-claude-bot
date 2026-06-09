/**
 * Pure, I/O-free helpers for the setup wizard and doctor.
 * No imports beyond the standard library so this stays a leaf under the
 * dependency-cruiser layering (services must not import bot).
 */

/** Parse `.env`-style text into a key→value map, ignoring comments and blanks. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

/**
 * Render an `.env` file from a template, applying `values` over matching keys.
 * Comments, blank lines, and key order from the template are preserved; keys in
 * `values` that are absent from the template are appended. Always ends in "\n".
 */
export function serializeEnv(template: string, values: Record<string, string>): string {
  if (template === "") {
    const appended = Object.entries(values).map(([k, v]) => `${k}=${v}`);
    return `${appended.join("\n")}\n`;
  }
  const seen = new Set<string>();
  const lines = template.split("\n");
  const body = template.endsWith("\n") ? lines.slice(0, -1) : lines;
  const result: string[] = [];

  for (const raw of body) {
    const trimmed = raw.trim();
    const eq = raw.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || eq === -1) {
      result.push(raw);
      continue;
    }
    const key = raw.slice(0, eq).trim();
    if (Object.hasOwn(values, key)) {
      result.push(`${key}=${values[key]}`);
      seen.add(key);
    } else {
      result.push(raw);
    }
  }
  for (const [key, val] of Object.entries(values)) {
    if (!seen.has(key)) result.push(`${key}=${val}`);
  }
  return `${result.join("\n")}\n`;
}

/** Extract the sender id (+ optional username) from a grammY/Bot-API update. */
export function parseCaptureUpdate(update: unknown): { id: string; username?: string } | null {
  const from = (update as { message?: { from?: { id?: number; username?: string } } })?.message
    ?.from;
  if (!from || typeof from.id !== "number") return null;
  return from.username ? { id: String(from.id), username: from.username } : { id: String(from.id) };
}

/** Cheap structural check for a Telegram bot token before any network call. */
export function validateTokenShape(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/** Mask a token for display, revealing only the last 4 characters. */
export function maskToken(token: string): string {
  const t = token.trim();
  return t.length <= 4 ? "••••" : `••••${t.slice(-4)}`;
}
