import telegramify from "telegramify-markdown";

// Characters that must be backslash-escaped in Telegram MarkdownV2 plain text.
const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape plain text (e.g. the header line) for Telegram MarkdownV2. */
export function escapeMarkdownV2(s: string): string {
  return s.replace(MDV2_SPECIAL, "\\$&");
}

/** Wrap raw text (terminal output) in a MarkdownV2 code block, escaping ` and \. */
export function codeBlockV2(body: string): string {
  const escaped = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  return `\`\`\`\n${escaped}\n\`\`\``;
}

/** Display width of a codepoint: East Asian wide chars (CJK) and emoji count as
 * 2, zero-width joiners/variation selectors as 0 — so monospace table columns
 * line up in Telegram's code blocks. Approximate but good enough for alignment. */
function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // ZWJ / variation selectors
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols + dingbats (❌ ✅ etc.)
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

function padTo(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

// A GFM table separator row, e.g. `| --- | :--: |` or `---|---`.
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Telegram MarkdownV2 has no tables — telegramify would escape them into an
 * unreadable `\|`-laden mess. Convert each GFM pipe table to a monospace code
 * block with display-width-aligned columns (which Telegram renders cleanly and
 * telegramify passes through verbatim). Non-table text is left untouched.
 */
export function tablesToCodeBlocks(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const sep = lines[i + 1];
    if (sep === undefined || !line.includes("|") || !TABLE_SEP.test(sep)) {
      out.push(line);
      i++;
      continue;
    }
    const rows = [splitTableRow(line)];
    let j = i + 2; // skip header + separator
    while (true) {
      const row = lines[j];
      if (row === undefined || !row.includes("|") || row.trim() === "") break;
      rows.push(splitTableRow(row));
      j++;
    }
    const cols = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, c) =>
      Math.max(...rows.map((r) => displayWidth(r[c] ?? ""))),
    );
    const renderRow = (r: string[]) =>
      r
        .map((cell, c) => padTo(cell, widths[c] ?? 0))
        .join("  ")
        .trimEnd();
    const divider = widths.map((w) => "-".repeat(w)).join("  ");
    const [header = [], ...body] = rows;
    out.push("```", renderRow(header), divider, ...body.map(renderRow), "```");
    i = j;
  }
  return out.join("\n");
}

/**
 * Convert Claude's CommonMark/GFM markdown to Telegram MarkdownV2 via
 * telegramify-markdown (handles escaping + downgrading headings/etc.). GFM
 * tables are pre-converted to aligned code blocks first (Telegram has no tables).
 * Never throws — falls back to a fully-escaped version of the raw text.
 */
export function toTelegramMarkdown(md: string): string {
  if (!md.trim()) return "";
  try {
    return telegramify(tablesToCodeBlocks(md), "escape");
  } catch {
    return escapeMarkdownV2(md);
  }
}

/**
 * Strip MarkdownV2 back to readable plain text — a last-resort fallback when
 * Telegram rejects the formatted message.
 */
export function stripMarkdownV2(s: string): string {
  return s
    .replace(/```[a-z]*\n?/gi, "") // open/close code fences
    .replace(/```/g, "")
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1") // unescape \x → x
    .replace(/[*_~`]/g, ""); // drop remaining inline markers
}
