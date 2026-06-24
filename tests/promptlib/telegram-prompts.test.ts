import { describe, expect, it } from "vitest";
import { buildPromptsKeyboard, parseCallbackData } from "../../src/adapters/telegram/keyboards.js";
import { sessionShortId } from "../../src/shared/utils/hash.js";

describe("buildPromptsKeyboard", () => {
  it("renders a button per prompt (callback pp:<sid>) + tag buttons + paging", () => {
    const items = [{ name: "code-review", tags: ["review"], description: "", snippet: "" }];
    const tags = [{ tag: "review", count: 1 }];
    const kb = buildPromptsKeyboard(items, tags, { page: 0, totalPages: 2, tagFilter: "" }) as any;
    const flat = JSON.stringify(kb.inline_keyboard);
    expect(flat).toContain(`pp:${sessionShortId("code-review")}`);
    expect(flat).toContain(`pf:${sessionShortId("review")}`);
    expect(flat).toContain("pn:1:_"); // next page, no filter
  });
});

describe("parseCallbackData — prompt tokens", () => {
  it("parses pp/pf/pn", () => {
    expect(parseCallbackData("pp:abc123")).toEqual({ kind: "promptget", sid: "abc123" });
    expect(parseCallbackData("pf:def456")).toEqual({ kind: "promptfilter", tagSid: "def456" });
    expect(parseCallbackData("pn:2:def456")).toEqual({
      kind: "promptpage",
      page: 2,
      tagSid: "def456",
    });
    expect(parseCallbackData("pn:0:_")).toEqual({ kind: "promptpage", page: 0, tagSid: "" });
  });
});
