import { describe, expect, it } from "vitest";
import {
  codeBlockV2,
  escapeMarkdownV2,
  stripMarkdownV2,
  tablesToCodeBlocks,
  toTelegramMarkdown,
} from "../src/adapters/telegram/markdown.js";

describe("escapeMarkdownV2", () => {
  it("backslash-escapes MarkdownV2-significant characters", () => {
    expect(escapeMarkdownV2("a.b-c(d)")).toBe("a\\.b\\-c\\(d\\)");
  });
  it("leaves ordinary text untouched", () => {
    expect(escapeMarkdownV2("myapp 完成")).toBe("myapp 完成");
  });
});

describe("codeBlockV2", () => {
  it("wraps text in a code fence and escapes backticks/backslashes", () => {
    const out = codeBlockV2("a `b` \\c");
    expect(out.startsWith("```\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
    expect(out).toContain("a \\`b\\` \\\\c");
  });
});

describe("tablesToCodeBlocks", () => {
  it("converts a GFM table to an aligned monospace code block", () => {
    const md = "| a | bb |\n| --- | --- |\n| 1 | 2 |\n";
    const out = tablesToCodeBlocks(md);
    expect(out.startsWith("```\n")).toBe(true);
    expect(out.trimEnd().endsWith("```")).toBe(true);
    // no raw pipe-table left for telegramify to escape into `\|`
    expect(out).not.toContain("|");
    const lines = out.split("\n");
    expect(lines).toContain("a  bb");
    expect(lines).toContain("1  2");
  });

  it("aligns columns by display width (CJK counts as 2)", () => {
    const md = "| k | v |\n|---|---|\n| 推送 | x |\n| a | y |\n";
    const out = tablesToCodeBlocks(md);
    // First column width is 4 display columns. "a" (1) is padded to 4, i.e.
    // "a" + 3 spaces; the CJK cell needs no extra padding before the column gap.
    expect(out).toContain("a   "); // a padded to width 4
    expect(out).toContain("推送  x"); // 推送 (width 4) + 2-space gap + x
  });

  it("leaves non-table text untouched", () => {
    const md = "# Title\n\nsome **text** and a list:\n- one\n- two\n";
    expect(tablesToCodeBlocks(md)).toBe(md);
  });

  it("does not treat a pipe line as a table when the next line is not a separator", () => {
    // A line with a pipe but no GFM separator below it is plain text, not a table.
    const md = "a | b is not a table\njust prose\n";
    expect(tablesToCodeBlocks(md)).toBe(md);
  });

  it("does not treat the last line as a table (no separator row below it)", () => {
    const md = "trailing | pipe at eof";
    expect(tablesToCodeBlocks(md)).toBe(md);
  });

  it("parses rows that omit the leading/trailing pipe delimiters", () => {
    // splitTableRow must handle borderless GFM rows (no leading/trailing `|`).
    const md = "a | b\n--- | ---\n1 | 2\n";
    const out = tablesToCodeBlocks(md);
    const lines = out.split("\n");
    expect(lines).toContain("a  b");
    expect(lines).toContain("1  2");
    expect(out).not.toContain("|");
  });

  it("unescapes \\| inside a cell and does not split on it", () => {
    const md = "| a | b |\n| --- | --- |\n| x \\| y | z |\n";
    const out = tablesToCodeBlocks(md);
    // The escaped pipe becomes a literal | inside the cell, not a column break.
    expect(out).toContain("x | y");
  });

  it("pads ragged rows (missing trailing cells) to the column count", () => {
    // Body row has fewer cells than the header → padTo over an undefined cell.
    const md = "| a | b | c |\n| --- | --- | --- |\n| 1 |\n";
    const out = tablesToCodeBlocks(md);
    const lines = out.split("\n");
    // header defines 3 columns; the short row still renders aligned to col 1.
    expect(lines.some((l) => l.startsWith("a"))).toBe(true);
    expect(lines.some((l) => l.trimEnd() === "1")).toBe(true);
  });

  it("ends a table at the first blank line and keeps following prose", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter the table\n";
    const out = tablesToCodeBlocks(md);
    expect(out).toContain("after the table");
    expect(out.split("```").length - 1).toBe(2); // exactly one fenced block
  });

  it("counts zero-width joiners/variation selectors as width 0 (alignment)", () => {
    // ❤️ = U+2764 (width-2 dingbat) + U+FE0F (variation selector, width 0).
    // A ZWJ-joined family emoji is multiple width-2 codepoints joined by ZWJ (0).
    const md = "| icon | n |\n| --- | --- |\n| ❤️ | 1 |\n| ab | 2 |\n";
    const lines = tablesToCodeBlocks(md).split("\n");
    const heart = lines.find((l) => l.startsWith("❤️")) ?? "";
    const ab = lines.find((l) => l.startsWith("ab")) ?? "";
    // The variation selector contributes 0, so ❤️ measures width 2 — identical to
    // "ab" — so both cells receive the exact same trailing padding before the digit.
    const padOf = (line: string, cell: string) => line.slice(cell.length).match(/^ */)?.[0] ?? "";
    expect(padOf(heart, "❤️")).toBe(padOf(ab, "ab"));
    expect(heart).toMatch(/1$/);
  });

  it("aligns Hangul, fullwidth, and CJK-ExtB (all width 2) like other CJK", () => {
    // Hangul, fullwidth Latin, and CJK extension characters are width 2.
    const md = "| k | v |\n| --- | --- |\n| 한Ａ | x |\n| abcd | y |\n";
    const out = tablesToCodeBlocks(md);
    // "한Ａ" = 4 display cols, equal to "abcd"; both get the same trailing gap.
    expect(out).toContain("한Ａ  x");
    expect(out).toContain("abcd  y");
  });

  it("toTelegramMarkdown renders a table as a code block, not escaped pipes", () => {
    const out = toTelegramMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(out).toContain("```");
    expect(out).not.toContain("\\|");
  });
});

describe("toTelegramMarkdown (via telegramify-markdown)", () => {
  it("converts **bold** to MarkdownV2 *bold*", () => {
    expect(toTelegramMarkdown("**hi**")).toContain("*hi*");
  });
  it("escapes special characters like the period", () => {
    expect(toTelegramMarkdown("done.")).toContain("done\\.");
  });
  it("returns empty string for blank input", () => {
    expect(toTelegramMarkdown("")).toBe("");
    expect(toTelegramMarkdown("   ")).toBe("");
  });
  it("never throws (returns a string for arbitrary input)", () => {
    expect(typeof toTelegramMarkdown("a < b ][ ( weird **")).toBe("string");
  });
});

describe("stripMarkdownV2", () => {
  it("unescapes backslash escapes and drops inline markers", () => {
    expect(stripMarkdownV2("done\\. *bold* `code`")).toBe("done. bold code");
  });
  it("unwraps code fences", () => {
    expect(stripMarkdownV2("```\nconst x = 1\n```")).toContain("const x = 1");
  });
});
