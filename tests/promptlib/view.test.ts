import { describe, expect, it, vi } from "vitest";
import type { PromptLib } from "../../src/core/promptlib/promptlib.js";
import { buildPromptsPage, PROMPTS_PAGE_SIZE } from "../../src/core/promptlib/view.js";
import { sessionShortId } from "../../src/shared/utils/hash.js";

function makeItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `prompt-${i}`,
    tags: [],
    description: "",
    snippet: "",
  }));
}

function fakeLib(
  items: ReturnType<typeof makeItems>,
  tags: Array<{ tag: string; count: number }> = [],
): { lib: PromptLib; listTagsSpy: ReturnType<typeof vi.fn> } {
  const listTagsSpy = vi.fn(async () => tags);
  const lib: PromptLib = {
    isEnabled: () => true,
    search: async () => items,
    get: async () => "",
    listTags: listTagsSpy,
  };
  return { lib, listTagsSpy };
}

describe("buildPromptsPage", () => {
  it("page-0 slice of N>8 items returns 8 items and correct totalPages", async () => {
    const { lib } = fakeLib(makeItems(20));
    const pg = await buildPromptsPage(lib, 0, "");
    expect(pg.items).toHaveLength(PROMPTS_PAGE_SIZE);
    expect(pg.view.totalPages).toBe(Math.ceil(20 / PROMPTS_PAGE_SIZE));
    expect(pg.total).toBe(20);
  });

  it("page beyond range clamps to last page", async () => {
    const { lib } = fakeLib(makeItems(10));
    const pg = await buildPromptsPage(lib, 99, "");
    expect(pg.view.page).toBe(1); // totalPages=2, last=1
    expect(pg.items).toHaveLength(2); // 10 - 8 = 2 on page 1
  });

  it("negative page clamps to 0", async () => {
    const { lib } = fakeLib(makeItems(5));
    const pg = await buildPromptsPage(lib, -5, "");
    expect(pg.view.page).toBe(0);
    expect(pg.items).toHaveLength(5);
  });

  it("tagFilter is passed through into view", async () => {
    const { lib } = fakeLib(makeItems(3));
    const pg = await buildPromptsPage(lib, 0, "mytag");
    expect(pg.view.tagFilter).toBe("mytag");
  });

  it("when prefetchedTags is supplied, lib.listTags is NOT called", async () => {
    const { lib, listTagsSpy } = fakeLib(makeItems(3));
    const prefetched = [{ tag: "review", count: sessionShortId("review").length }];
    const pg = await buildPromptsPage(lib, 0, "", prefetched);
    expect(listTagsSpy).not.toHaveBeenCalled();
    expect(pg.tags).toBe(prefetched);
  });

  it("when prefetchedTags is not supplied, lib.listTags IS called", async () => {
    const { lib, listTagsSpy } = fakeLib(makeItems(3), [{ tag: "review", count: 1 }]);
    await buildPromptsPage(lib, 0, "");
    expect(listTagsSpy).toHaveBeenCalledOnce();
  });

  it("empty results give totalPages=1 and total=0", async () => {
    const { lib } = fakeLib([]);
    const pg = await buildPromptsPage(lib, 0, "");
    expect(pg.total).toBe(0);
    expect(pg.view.totalPages).toBe(1);
    expect(pg.items).toHaveLength(0);
  });
});
