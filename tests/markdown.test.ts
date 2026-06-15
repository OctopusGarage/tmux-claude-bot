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
    // First column width = "推送" (4 display cols). "a" (1) is padded to 4, i.e.
    // "a" + 3 spaces; the CJK cell needs no extra padding before the column gap.
    expect(out).toContain("a   "); // a padded to width 4
    expect(out).toContain("推送  x"); // 推送 (width 4) + 2-space gap + x
  });

  it("leaves non-table text untouched", () => {
    const md = "# Title\n\nsome **text** and a list:\n- one\n- two\n";
    expect(tablesToCodeBlocks(md)).toBe(md);
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
