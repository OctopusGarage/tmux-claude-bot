import { describe, expect, it } from "vitest";
import { promptsCard } from "../../src/adapters/lark/cards.js";
import { sessionShortId } from "../../src/shared/utils/hash.js";

describe("promptsCard", () => {
  it("builds a card with per-prompt buttons + tag buttons + paging", () => {
    const items = [
      { name: "code-review", tags: ["review"], description: "审查", snippet: "审查改动" },
    ];
    const tags = [{ tag: "review", count: 1 }];
    const card = JSON.stringify(
      promptsCard(items, tags, { page: 0, totalPages: 2, tagFilter: "" }),
    );
    expect(card).toContain("code-review");
    expect(card).toContain(sessionShortId("code-review")); // pget sid
    expect(card).toContain(sessionShortId("review")); // pfilter tagSid
    expect(card).toContain("ppage"); // paging button cmd
    // (a) per-prompt button carries "pget"
    expect(card).toContain("pget");
  });

  it("marks active tag with ✅ when tagFilter is set", () => {
    const items = [
      { name: "code-review", tags: ["review"], description: "审查", snippet: "审查改动" },
    ];
    const tags = [{ tag: "review", count: 1 }];
    const card = JSON.stringify(
      promptsCard(items, tags, { page: 0, totalPages: 1, tagFilter: "review" }),
    );
    // (b) active tag shows ✅
    expect(card).toContain("✅");
  });

  it("shows clear-filter button when tagFilter is non-empty", () => {
    const items = [
      { name: "code-review", tags: ["review"], description: "审查", snippet: "审查改动" },
    ];
    const tags = [{ tag: "review", count: 1 }];
    const card = JSON.stringify(
      promptsCard(items, tags, { page: 0, totalPages: 1, tagFilter: "review" }),
    );
    // (c) clear-filter button present (✖ 全部 or ppage+empty tagSid)
    expect(card).toContain("✖");
  });
});
