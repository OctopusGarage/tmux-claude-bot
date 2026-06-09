// Shell prompt glyphs that essentially never appear in Claude's prose answers
// but reliably mark a captured terminal pane.
const PROMPT_GLYPH = /[➜❯]/;
// user@host:path$  or  user@host:path#  style prompts (the prompt char may be
// at end of line, or followed by a typed command).
const USER_HOST_PROMPT = /\S+@\S+:.*?[$#%](\s|$)/m;
// conda-style "(base) " environment prefix at the start of a line
const CONDA_PREFIX = /^\s*\([\w.-]+\)\s+\S/m;

/**
 * Heuristic: does this text look like raw terminal output (so it should be sent
 * as a monospace code block), versus a natural-language / markdown answer from
 * Claude (which reads far better as normal prose)?
 *
 * Deliberately conservative — it only returns true on strong terminal signals,
 * so the common case (Claude's prose) is never forced into monospace. A
 * misclassified prose answer still degrades gracefully because the reply layer
 * falls back to plain text when Markdown parsing fails.
 */
export function looksLikeTerminalOutput(text: string): boolean {
  if (!text.trim()) return false;
  return PROMPT_GLYPH.test(text) || USER_HOST_PROMPT.test(text) || CONDA_PREFIX.test(text);
}
