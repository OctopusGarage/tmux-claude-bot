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

/**
 * Convert Claude's CommonMark/GFM markdown to Telegram MarkdownV2 via
 * telegramify-markdown (handles escaping + downgrading headings/tables/etc.).
 * Never throws — falls back to a fully-escaped version of the raw text.
 */
export function toTelegramMarkdown(md: string): string {
  if (!md.trim()) return "";
  try {
    return telegramify(md, "escape");
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
