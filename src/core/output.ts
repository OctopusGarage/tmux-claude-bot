// ANSI escape code regex. The literal FIRST character below is an ESC byte (0x1B)
// — it renders invisibly in most editors/viewers, so the literal looks like it
// starts with `/[@-_]` but is actually `/\x1b[@-_].../`, i.e. PROPERLY ANCHORED on
// ESC. Without that anchor the class `[@-_]` would match ordinary capital letters
// and eat plain text ("Hello" → "llo"). Do NOT "simplify" by removing the leading
// ESC; output.test.ts guards that plain capitalised text survives unchanged.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI ESC sequence
const ANSI_REGEX = /[@-_][0-?]*[ -/]*[@-~]/g;

export type OutputProcessorOptions = {
  maxOutputLines: number;
  maxMessageLength: number;
};

// Emoji markers used to convey, in plain text, the meaning the terminal's ANSI
// colours carried. Telegram has no text-colour API at all and sends the pane
// inside a code block (so markdown bold/colour can't render) — emoji are the
// only cross-platform styling that survives both the Telegram code block and the
// Lark card markdown. Faithful colour reproduction is impossible in text; this
// re-states the *state* a colour signalled, not the colour itself.
const MARK = { error: "❌", success: "✅", running: "⏳", add: "🟩", del: "🟥" } as const;

// A line that already opens with a status glyph (ours, or tmux/Claude's own
// ✓/✗) is left untouched — re-prefixing would just stack "❌ ✗ …".
const ALREADY_MARKED = /^\s*(❌|✅|⏳|🟩|🟥|✗|✘|×|✓|✔|☑)/u;
// Error: an "Error"/"Traceback"/… word at line start, or a "<word>:" label.
// Plurals are deliberately excluded ("errors:" won't match "error\s*:"), so
// reassuring prose like "no errors:" is not falsely flagged.
const ERROR_RE =
  /^\s*(error|fatal|panic|exception|traceback)\b|\b(error|exception|failed|failure)\s*:/i;
const SUCCESS_RE = /^\s*(done|success|passed|completed)\b|\b(passed|succeeded)\b/i;
// Running/waiting: Claude's "(esc to interrupt)" hint, or a gerund-style status
// line ending in an ellipsis ("Building…", "Installing ...").
const RUNNING_RE =
  /esc to interrupt|^\s*(waiting|running|loading|building|compiling|installing|fetching|downloading)\b.*(…|\.\.\.)\s*$/i;
// A diff line: a single leading +/- followed by a space. Anchored at column 0
// (post-clean diff hunks start there); leading-indented bullets won't match.
const DIFF_LINE_RE = /^([+-]) /;

/**
 * Annotate raw terminal-pane text with emoji markers so the *meaning* the
 * original ANSI colours conveyed survives the trip to a colourless text channel.
 * Conservative by design — it prefers to miss a signal than to mislabel a line.
 *
 * Scope: call this ONLY on a captured tmux pane (the peek/view path). It must
 * NOT run on Claude's prose answers, where "- " bullets and stray "Error:" in a
 * sentence would be mismarked.
 *
 * Diff detection requires a contiguous +/- block to contain BOTH an addition and
 * a removal — a plain bullet list (all "- ") therefore never trips it, at the
 * cost of skipping pure-addition / pure-deletion hunks.
 */
export function markSemantics(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");

  // Pass 1: flag lines belonging to a real diff hunk (mixed +/- block).
  const isDiff = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!DIFF_LINE_RE.test(lines[i] ?? "")) {
      i++;
      continue;
    }
    let j = i;
    let hasAdd = false;
    let hasDel = false;
    while (j < lines.length) {
      const m = (lines[j] ?? "").match(DIFF_LINE_RE);
      if (!m) break;
      if (m[1] === "+") hasAdd = true;
      else hasDel = true;
      j++;
    }
    if (hasAdd && hasDel) {
      for (let k = i; k < j; k++) isDiff[k] = true;
    }
    i = j;
  }

  // Pass 2: emit one marker per line (diff > error > success > running).
  return lines
    .map((line, idx) => {
      if (isDiff[idx]) {
        return (line[0] === "+" ? MARK.add : MARK.del) + line.slice(1);
      }
      if (ALREADY_MARKED.test(line)) return line;
      if (ERROR_RE.test(line)) return `${MARK.error} ${line}`;
      if (SUCCESS_RE.test(line)) return `${MARK.success} ${line}`;
      if (RUNNING_RE.test(line)) return `${MARK.running} ${line}`;
      return line;
    })
    .join("\n");
}

export class OutputProcessor {
  private readonly maxOutputLines: number;
  private readonly maxMessageLength: number;

  constructor(options: OutputProcessorOptions) {
    this.maxOutputLines = options.maxOutputLines;
    this.maxMessageLength = options.maxMessageLength;
  }

  private clean(text: string): string {
    // Remove ANSI escape codes
    let cleaned = text.replace(ANSI_REGEX, "");
    // Remove tmux box drawing chars and UI elements
    cleaned = cleaned.replace(/[╭│➜⏵⏺❯▌▛█▜▝⎿⏣╮╯╰▀▐░▒▓]+/g, "");
    // Remove hook errors and system messages (only at line start to avoid deleting legitimate content)
    cleaned = cleaned.replace(/^hook error.*$/gim, "");
    cleaned = cleaned.replace(/^UserPromptSubmit.*$/gim, "");
    cleaned = cleaned.replace(/^english-gate\.sh.*$/gim, "");
    cleaned = cleaned.replace(/^bash:.*\.sh.*$/gim, "");
    // Remove lines that are mostly noise
    cleaned = cleaned
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        if (/^[╭│─➜⏵⏺❯▌▛█▜▝⎿⏣ \-=★•·]+$/.test(t)) return false;
        if (t.includes("UserPromptSubmit")) return false;
        if (t.includes("hook error")) return false;
        if (t.includes("english-gate")) return false;
        return true;
      })
      .join("\n");
    // Empty lines were already filtered out above; no need to collapse further
    return cleaned.trim();
  }

  process(rawOutput: string): string {
    // Step 1: Clean noise
    const cleaned = this.clean(rawOutput);

    // Step 2: Split into lines, take last N lines
    const lines = cleaned.split("\n");
    const lastLines = lines.slice(-this.maxOutputLines);

    // Step 3: Trim and join
    let result = lastLines.join("\n").trim();

    // Step 4: Truncate to message limit (leave room for code block wrapper)
    const wrapperOverhead = 8; // ```\n...\n```
    const maxContent = this.maxMessageLength - wrapperOverhead;
    if (result.length > maxContent) {
      const start = result.length - maxContent;
      // Avoid cutting mid-line: start from the next newline after the cut point
      const firstNewline = result.indexOf("\n", start);
      if (firstNewline >= 0) {
        result = result.slice(firstNewline + 1);
      } else {
        result = result.slice(start);
      }
    }

    return result;
  }
}
