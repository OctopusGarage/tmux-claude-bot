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

/** Scrollback lines a bare /peek captures (≈ one chat message; ~2× the visible
 * pane). `/peek N` overrides, up to MAX_PEEK_LINES; paging splits whatever results
 * across messages as needed. */
export const DEFAULT_PEEK_LINES = 40;
export const MAX_PEEK_LINES = 500;

/** Parse the `/peek N` argument → line count clamped to [1, MAX], or the default
 * for no/bad arg. (Small N is honoured as-is; paging adapts to the actual size.) */
export function parsePeekLines(arg: string | undefined): number {
  const n = arg ? Number.parseInt(arg, 10) : Number.NaN;
  if (Number.isNaN(n) || n <= 0) return DEFAULT_PEEK_LINES;
  return Math.min(n, MAX_PEEK_LINES);
}

// One SGR (colour/attribute) sequence, e.g. ESC[2m or ESC[38;5;240m.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC is intentional
const SGR_RE = /\x1b\[([0-9;]*)m/g;
// Faint/gray runs (placeholder hints, inactive text) get this prefix so a hint
// reads as a hint in colourless chat — e.g. the input box placeholder you can't
// otherwise tell apart from real, typed/selected text.
const MUTED_MARK = "🔅";

/** Whether an extended-colour spec (the params AFTER `38`) is a gray, the usual
 * colour of hint/placeholder text. Covers 256-colour grays and near-gray RGB. */
function isGrayExtendedColor(params: number[]): boolean {
  if (params[0] === 5) {
    const n = params[1] ?? -1;
    return n === 8 || (n >= 232 && n <= 243); // bright-black + low grayscale ramp
  }
  if (params[0] === 2) {
    const r = params[1] ?? 0;
    const g = params[2] ?? 0;
    const b = params[3] ?? 0;
    return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && Math.max(r, g, b) <= 150;
  }
  return false;
}

/** Update the running "muted" flag from one SGR sequence's parameters. */
function nextMuted(prev: boolean, sgr: string | undefined): boolean {
  const codes = (sgr ?? "").split(";").map((c) => (c === "" ? 0 : Number(c)));
  let muted = prev;
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === undefined) continue;
    // 2 = faint/dim, 90 = gray fg → muted. 0/22/39 + any real colour → not muted.
    if (c === 2 || c === 90) {
      muted = true;
    } else if (c === 0 || c === 22 || c === 39 || (c >= 30 && c <= 37) || (c >= 91 && c <= 97)) {
      muted = false;
    } else if (c === 38) {
      muted = isGrayExtendedColor(codes.slice(i + 1)); // extended fg: 38;5;N | 38;2;r;g;b
      break;
    }
  }
  return muted;
}

/**
 * Make ANSI COLOUR MEANING survive into colourless chat: prefix faint/gray text
 * (placeholder hints, inactive/secondary text) with {@link MUTED_MARK} — ONCE per
 * line, at the first muted char, so a line broken into many gray words (claude
 * wraps each word in its own SGR) reads as one hint, not "🔅w1 🔅w2 🔅w3". Must run
 * on a pane captured WITH colour (`capture-pane -e`) and BEFORE the colourless
 * OutputProcessor, which would otherwise discard the escapes (and the meaning).
 */
export function markColorSemantics(ansi: string): string {
  let muted = false;
  let markedThisLine = false;
  let out = "";
  let last = 0;
  const emit = (text: string, isMuted: boolean): void => {
    for (const ch of text) {
      if (ch === "\n") {
        markedThisLine = false;
      } else if (isMuted && !markedThisLine && !/\s/.test(ch)) {
        out += MUTED_MARK; // one marker per line, before its first gray glyph
        markedThisLine = true;
      }
      out += ch;
    }
  };
  for (const m of ansi.matchAll(SGR_RE)) {
    const idx = m.index;
    emit(ansi.slice(last, idx), muted);
    muted = nextMuted(muted, m[1]);
    last = idx + m[0].length;
  }
  emit(ansi.slice(last), muted);
  return out;
}

/** Full peek render: colour meaning (🔅 hints) → strip ANSI/box noise (keeping
 * ❯/➜ selection arrows) → diff/error/etc. markers. Shared by both adapters. */
export function renderPeekPane(coloredSnapshot: string, output: OutputProcessor): string {
  return markSemantics(output.process(markColorSemantics(coloredSnapshot)));
}

/**
 * Peek render for paging: same passes as {@link renderPeekPane} but keep the last
 * `maxLines` and split into message-sized chunks (each ≤ `maxChars`, on line
 * boundaries) — top→bottom — so a tall capture is sent across several messages
 * instead of truncated to one. Returns [] for an empty pane.
 */
export function renderPeekPaneChunks(
  coloredSnapshot: string,
  output: OutputProcessor,
  maxLines: number,
  maxChars: number,
): string[] {
  const marked = markSemantics(output.clean(markColorSemantics(coloredSnapshot))).trim();
  if (!marked) return [];
  const lines = marked.split("\n").slice(-maxLines);
  const chunks: string[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) chunks.push(buf);
    buf = "";
  };
  for (const line of lines) {
    if (line.length > maxChars) {
      // A single over-long line: flush, then hard-slice it across chunks.
      flush();
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    if (buf && buf.length + 1 + line.length > maxChars) flush();
    buf = buf ? `${buf}\n${line}` : line;
  }
  flush();
  return chunks;
}

export class OutputProcessor {
  private readonly maxOutputLines: number;
  private readonly maxMessageLength: number;

  constructor(options: OutputProcessorOptions) {
    this.maxOutputLines = options.maxOutputLines;
    this.maxMessageLength = options.maxMessageLength;
  }

  /** Strip ANSI / box-noise without the single-message truncation — peek paging
   * cleans once, then splits into message-sized chunks itself. */
  clean(text: string): string {
    // Remove ANSI escape codes
    let cleaned = text.replace(ANSI_REGEX, "");
    // Remove tmux box-drawing / spinner noise — but KEEP the selection/prompt
    // arrows ❯ ➜ ›, which mark the highlighted menu item (peek must show what's
    // selected, not silently drop it).
    cleaned = cleaned.replace(/[╭│⏵⏺▌▛█▜▝⎿⏣╮╯╰▀▐░▒▓]+/g, "");
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
        if (/^[╭│─⏵⏺▌▛█▜▝⎿⏣ \-=★•·]+$/.test(t)) return false;
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
