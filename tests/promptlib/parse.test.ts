import { describe, expect, it } from "vitest";
import { parseSearchResults, parseTagList } from "../../src/core/promptlib/parse.js";

describe("parseSearchResults", () => {
  it("parses rows with name/tags/description + snippet", () => {
    const text = [
      "找到 2 条:",
      "• code-review  [review, quality] — 代码审查",
      "    审查改动,关注边界条件",
      "• debug-help  []",
      "    帮我定位 bug",
    ].join("\n");
    const r = parseSearchResults(text);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      name: "code-review",
      tags: ["review", "quality"],
      description: "代码审查",
      snippet: "审查改动,关注边界条件",
    });
    expect(r[1]).toEqual({
      name: "debug-help",
      tags: [],
      description: "",
      snippet: "帮我定位 bug",
    });
  });
  it("returns [] for empty/not-found output", () => {
    expect(parseSearchResults("未找到匹配的提示词")).toEqual([]);
    expect(parseSearchResults("提示词库为空,用 save_prompt(name, content) 收藏第一条")).toEqual([]);
  });

  it("parses names containing brackets (greedy name, last bracket is the tags field)", () => {
    const text = "找到 1 条:\n• review [strict]  [tag1, tag2] — 审查\n    body";
    const r = parseSearchResults(text);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      name: "review [strict]",
      tags: ["tag1", "tag2"],
      description: "审查",
      snippet: "body",
    });
  });
});

describe("parseTagList", () => {
  it("parses tag + count lines", () => {
    expect(parseTagList("标签:\n  review (3)\n  debug (1)")).toEqual([
      { tag: "review", count: 3 },
      { tag: "debug", count: 1 },
    ]);
  });
  it("returns [] when no tags", () => {
    expect(parseTagList("还没有任何标签")).toEqual([]);
  });
});
