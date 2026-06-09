import { describe, expect, it } from "vitest";
import { looksLikeTerminalOutput } from "../src/adapters/telegram/format.js";

describe("looksLikeTerminalOutput", () => {
  it("treats a natural-language answer as prose, not terminal", () => {
    const prose = "我已经修复了这个 bug，根因是空指针。建议你再跑一遍测试确认。";
    expect(looksLikeTerminalOutput(prose)).toBe(false);
  });

  it("treats a markdown answer with code fences as prose", () => {
    const md = "Here is the fix:\n\n```ts\nconst x = 1;\n```\n\nThat should do it.";
    expect(looksLikeTerminalOutput(md)).toBe(false);
  });

  it("detects a zsh prompt glyph as terminal output", () => {
    const term = "➜  myproject git:(main) git status\nOn branch main\nnothing to commit";
    expect(looksLikeTerminalOutput(term)).toBe(true);
  });

  it("detects a powerlevel ❯ prompt as terminal output", () => {
    expect(looksLikeTerminalOutput("❯ ls -la\ntotal 8\ndrwxr-xr-x")).toBe(true);
  });

  it("detects a user@host shell prompt as terminal output", () => {
    expect(looksLikeTerminalOutput("user@host:~/project$ npm test")).toBe(true);
  });

  it("does not flag prose that merely mentions a dollar amount", () => {
    expect(looksLikeTerminalOutput("这个方案成本大约是 $5 每月，很划算。")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(looksLikeTerminalOutput("")).toBe(false);
  });
});
