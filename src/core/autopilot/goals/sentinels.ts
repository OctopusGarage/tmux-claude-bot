const SENTINEL_RE = /\[([A-Z][A-Z0-9_]+)\]/g;

/** Extract `[MARKER]` sentinel tokens (uppercase, digits, underscore; ≥2 chars),
 * deduped in first-seen order. Used to detect agent-emitted completion markers. */
export function extractSentinels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SENTINEL_RE)) {
    const token = m[1];
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}
