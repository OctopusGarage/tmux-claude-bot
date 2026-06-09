import { describe, expect, it } from "vitest";
import {
  codeBlockV2,
  escapeMarkdownV2,
  stripMarkdownV2,
  toTelegramMarkdown,
} from "../src/bot/markdown.js";

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
