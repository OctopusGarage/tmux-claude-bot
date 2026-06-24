import { describe, expect, it, vi } from "vitest";
import {
  makePromptLib,
  resolvePromptByShortId,
  resolveTagByShortId,
} from "../../src/core/promptlib/promptlib.js";

const baseConfig = { promptMcp: { command: "", args: [] } } as any;

describe("makePromptLib", () => {
  it("isEnabled reflects command presence", () => {
    expect(makePromptLib({ promptMcp: { command: "", args: [] } } as any).isEnabled()).toBe(false);
    expect(makePromptLib({ promptMcp: { command: "uv", args: [] } } as any).isEnabled()).toBe(true);
  });

  it("search/get/listTags call the right tools and parse", async () => {
    const caller = vi.fn(async (tool: string) => {
      if (tool === "search_prompts")
        return "找到 1 条:\n• code-review  [review] — 审查\n    审查改动";
      if (tool === "get_prompt") return "# code-review\n标签: review\n\n审查改动";
      if (tool === "list_prompt_tags") return "标签:\n  review (1)";
      return "";
    });
    const lib = makePromptLib(baseConfig, caller);
    const s = await lib.search("code", "");
    expect(caller).toHaveBeenCalledWith("search_prompts", { query: "code", tag: "" });
    expect(s[0]?.name).toBe("code-review");
    expect(await lib.get("code-review")).toContain("审查改动");
    expect(await lib.listTags()).toEqual([{ tag: "review", count: 1 }]);
  });

  it("resolvePromptByShortId / resolveTagByShortId map short id back to name/tag", async () => {
    const caller = vi.fn(async (tool: string) => {
      if (tool === "search_prompts") return "找到 1 条:\n• code-review  [review]";
      if (tool === "list_prompt_tags") return "标签:\n  review (1)";
      return "";
    });
    const lib = makePromptLib(baseConfig, caller);
    const { sessionShortId } = await import("../../src/shared/utils/hash.js");
    expect(await resolvePromptByShortId(lib, sessionShortId("code-review"))).toBe("code-review");
    expect(await resolveTagByShortId(lib, sessionShortId("review"))).toBe("review");
    expect(await resolvePromptByShortId(lib, "zzzzzz")).toBeNull();
  });
});
