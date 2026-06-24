import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the reply sink so sendPromptsPage (+ buildPromptsPage + the keyboard
// builder) run for real and assert which reply was sent — prompts.ts coverage
// stays attributed because its own imports are not replaced wholesale.
const { reply } = vi.hoisted(() => ({ reply: vi.fn(async () => {}) }));
vi.mock("../../../src/adapters/telegram/replies.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/adapters/telegram/replies.js")>()),
  reply,
}));

import { sendPromptsPage } from "../../../src/adapters/telegram/prompts.js";
import { messages } from "../../../src/core/i18n/index.js";
import type { PromptSummary } from "../../../src/core/promptlib/parse.js";
import type { PromptLib } from "../../../src/core/promptlib/promptlib.js";

const items = (n: number): PromptSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `p${i}`,
    tags: ["t"],
    description: "d",
    snippet: "s",
  }));

const fakeLib = (over: Partial<PromptLib> = {}): PromptLib => ({
  isEnabled: () => true,
  search: vi.fn(async () => items(3)),
  get: vi.fn(async () => ""),
  listTags: vi.fn(async () => [{ tag: "t", count: 3 }]),
  ...over,
});

const ctx = {} as never;
const target = {} as never;
const m = messages("telegram");

beforeEach(() => reply.mockClear());

describe("sendPromptsPage", () => {
  it("replies promptsEmpty when the library has no prompts", async () => {
    const lib = fakeLib({ search: vi.fn(async () => []), listTags: vi.fn(async () => []) });
    await sendPromptsPage(ctx, lib, 0, "", target);
    expect(reply).toHaveBeenCalledTimes(1);
    const [, kind, text] = reply.mock.calls[0] as unknown as [unknown, string, string];
    expect(kind).toBe("list");
    expect(text).toBe(m.promptsEmpty);
  });

  it("replies a titled list with a keyboard when there are prompts", async () => {
    await sendPromptsPage(ctx, fakeLib(), 0, "", target);
    const [, kind, text, opts] = reply.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      { replyMarkup?: unknown },
    ];
    expect(kind).toBe("list");
    expect(text).toBe(m.promptsTitle(3));
    expect(opts.replyMarkup).toBeDefined();
  });

  it("passes the tag filter through to the library search", async () => {
    const search = vi.fn(async () => items(1));
    await sendPromptsPage(ctx, fakeLib({ search }), 0, "review", target);
    expect(search).toHaveBeenCalledWith("", "review");
  });

  it("uses prefetched tags and skips a redundant listTags call", async () => {
    const listTags = vi.fn(async () => []);
    await sendPromptsPage(ctx, fakeLib({ listTags }), 0, "", target, [{ tag: "t", count: 1 }]);
    expect(listTags).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
