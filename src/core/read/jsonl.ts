/**
 * Iterate the parsed objects of a JSONL text, carrying the torn-line policy in
 * ONE place. Both agents read a transcript file while the agent is still
 * appending to it, so the final line can be partially flushed: split on
 * newlines, skip blank lines, and skip any line that fails to parse (the torn
 * tail) — yield the rest.
 *
 * `yield` sits OUTSIDE the try so a consumer's own throw is never swallowed as if
 * it were a torn line.
 */
export function* iterJsonlObjects<T>(jsonlText: string): Generator<T> {
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: T;
    try {
      obj = JSON.parse(trimmed) as T;
    } catch {
      continue; // torn / non-JSON line — skip
    }
    yield obj;
  }
}
