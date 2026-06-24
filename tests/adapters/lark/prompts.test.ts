/**
 * Behavior tests for the Lark /prompts surface:
 *   - sendPrompts (src/adapters/lark/prompts.ts)          — all branches
 *   - handlers.ts "prompts" case                          — p2p gate
 *   - cards.ts promptsCard                                — rendering branches
 *   - card-actions.ts pget / pfilter / ppage handlers     — card-action routing
 *
 * All fake prompt calls are injected via the `caller` seam in makePromptLib;
 * no real MCP subprocess is spawned.
 */

import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Stub voice support to avoid real subprocess checks ──────────────────────
vi.mock("../../../src/core/read/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/voice-support.js")>()),
  checkVoiceSupport: vi.fn(() => ({ ready: false, reason: "not-installed" })),
  isVoicePlatformSupported: vi.fn(() => false),
  installVoice: vi.fn(async () => ({ status: "ok" })),
  persistEnvVar: vi.fn(),
}));

// ── Stub makePromptLib so tests control search/get/listTags deterministically ─
// We intercept at the factory level — callers (sendPrompts, card-actions) call
// makePromptLib(config, [caller]), passing the caller as a second arg only when
// they have one. The real factory accepts an optional caller: we mock the whole
// module and make makePromptLib return a fake lib whose behaviour the test sets.

const fakeCallerFn = vi.fn<(tool: string, args: Record<string, unknown>) => Promise<string>>();

vi.mock("../../../src/core/promptlib/promptlib.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../src/core/promptlib/promptlib.js")>();
  return {
    ...orig,
    makePromptLib: (config: { promptMcp: { command: string; args: string[] } }) => {
      const enabled = config.promptMcp.command.trim().length > 0;
      return orig.makePromptLib(config as never, enabled ? fakeCallerFn : undefined);
    },
  };
});

// ── Dynamic imports (after mocks are registered) ────────────────────────────
const { sendPrompts } = await import("../../../src/adapters/lark/prompts.js");
const { makeMessageHandler } = await import("../../../src/adapters/lark/handlers.js");
const { makeCardActionHandler } = await import("../../../src/adapters/lark/card-actions.js");
const { promptsCard } = await import("../../../src/adapters/lark/cards.js");
const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");

// ── Config helpers ───────────────────────────────────────────────────────────

/** Config with promptMcp disabled (empty command) */
function disabledPromptConfig() {
  return { promptMcp: { command: "", args: [] } };
}

/** Config with promptMcp enabled (non-empty command) */
function enabledPromptConfig() {
  return { promptMcp: { command: "forge-mcp", args: [] } };
}

/** Card-action event helper */
function cardEvt(value: unknown, over: Partial<CardActionEvent> = {}): CardActionEvent {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    operator: { openId: "ou_me" },
    action: { value, tag: "button" },
    ...over,
  } as CardActionEvent;
}

// ── Fake caller responses ────────────────────────────────────────────────────

const SEARCH_ONE = "找到 1 条:\n• code-review  [review] — 审查\n    审查改动";
const SEARCH_EMPTY = "找到 0 条:";
const TAGS_ONE = "标签:\n  review (1)";
const GET_BODY = "# code-review\n标签: review\n\n审查改动";

// ────────────────────────────────────────────────────────────────────────────
// sendPrompts — all branches
// ────────────────────────────────────────────────────────────────────────────

describe("sendPrompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disabled → sendText with promptsDisabled message", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: disabledPromptConfig() });
    await sendPrompts(channel, deps, "chat-1", undefined);
    expect(channel.texts().some((t) => t.includes("未启用"))).toBe(true);
    expect(channel.cards()).toHaveLength(0);
  });

  it("search arg with results → sendCard with matching items", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    await sendPrompts(channel, deps, "chat-1", "code-review");
    expect(channel.cards()).toHaveLength(1);
    const card = JSON.stringify(channel.cards()[0]);
    expect(card).toContain("code-review");
  });

  it("search arg with no results → sendText with promptsEmpty message", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_EMPTY;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    await sendPrompts(channel, deps, "chat-1", "nonexistent");
    expect(channel.texts().some((t) => t.includes("没有匹配"))).toBe(true);
    expect(channel.cards()).toHaveLength(0);
  });

  it("no arg, page has results → sendCard", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_ONE;
      if (tool === "list_prompt_tags") return TAGS_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    await sendPrompts(channel, deps, "chat-1", undefined);
    expect(channel.cards()).toHaveLength(1);
  });

  it("no arg, page is empty (total 0) → sendText with promptsEmpty", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_EMPTY;
      if (tool === "list_prompt_tags") return TAGS_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    await sendPrompts(channel, deps, "chat-1", undefined);
    expect(channel.texts().some((t) => t.includes("没有匹配"))).toBe(true);
    expect(channel.cards()).toHaveLength(0);
  });

  it("thrown error during search → sendText with promptsError message", async () => {
    fakeCallerFn.mockRejectedValue(new Error("MCP connection failed"));
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    await sendPrompts(channel, deps, "chat-1", "anything");
    expect(channel.texts().some((t) => t.includes("连接失败"))).toBe(true);
    expect(channel.cards()).toHaveLength(0);
  });

  it("no arg with prefetchedTags skips redundant listTags call", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_ONE;
      // listTags should NOT be called with prefetchedTags provided
      if (tool === "list_prompt_tags") return TAGS_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const prefetchedTags = [{ tag: "review", count: 1 }];
    await sendPrompts(channel, deps, "chat-1", undefined, 0, "", prefetchedTags);
    // listTags not called (prefetchedTags bypassed it)
    const listTagsCalls = fakeCallerFn.mock.calls.filter(([t]) => t === "list_prompt_tags");
    expect(listTagsCalls).toHaveLength(0);
    expect(channel.cards()).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handlers.ts — "prompts" case: p2p gate
// ────────────────────────────────────────────────────────────────────────────

describe("handlers.ts /prompts dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("p2p message with /prompts disabled → sends promptsDisabled text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: disabledPromptConfig() });
    const handler = makeMessageHandler(channel, deps);
    await handler(fakeMessage({ content: "/prompts", chatType: "p2p" }));
    expect(channel.texts().some((t) => t.includes("未启用"))).toBe(true);
  });

  it("non-p2p message with /prompts → no reply (p2p-gated)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: disabledPromptConfig() });
    const handler = makeMessageHandler(channel, deps);
    await handler(fakeMessage({ content: "/prompts", chatType: "group" }));
    // The handler's group-chat gate drops early (ignoresNon-p2p chats entirely)
    // for the prompts case — nothing is sent.
    expect(channel.texts().some((t) => t.includes("未启用"))).toBe(false);
    expect(channel.cards()).toHaveLength(0);
  });

  it("p2p /prompts with enabled lib and results → sends a card", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_ONE;
      if (tool === "list_prompt_tags") return TAGS_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handler = makeMessageHandler(channel, deps);
    await handler(fakeMessage({ content: "/prompts", chatType: "p2p" }));
    expect(channel.cards()).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// cards.ts — promptsCard rendering branches
// ────────────────────────────────────────────────────────────────────────────

describe("promptsCard rendering", () => {
  const oneItem = [{ name: "code-review", tags: ["review"], description: "审查", snippet: "x" }];

  it("renders prompt name, pget button and tagSid in serialized card", () => {
    const card = JSON.stringify(
      promptsCard(oneItem, [], { page: 0, totalPages: 1, tagFilter: "" }),
    );
    expect(card).toContain("code-review");
    expect(card).toContain("pget");
    expect(card).toContain(sessionShortId("code-review"));
  });

  it("renders tag filter button with pfilter cmd", () => {
    const tags = [{ tag: "review", count: 1 }];
    const card = JSON.stringify(
      promptsCard(oneItem, tags, { page: 0, totalPages: 1, tagFilter: "" }),
    );
    expect(card).toContain("pfilter");
    expect(card).toContain(sessionShortId("review"));
  });

  it("active tag shows ✅ prefix", () => {
    const tags = [{ tag: "review", count: 1 }];
    const card = JSON.stringify(
      promptsCard(oneItem, tags, { page: 0, totalPages: 1, tagFilter: "review" }),
    );
    expect(card).toContain("✅");
  });

  it("non-active tag shows 🏷 prefix", () => {
    const tags = [
      { tag: "review", count: 1 },
      { tag: "other", count: 2 },
    ];
    const card = JSON.stringify(
      promptsCard(oneItem, tags, { page: 0, totalPages: 1, tagFilter: "review" }),
    );
    expect(card).toContain("🏷");
  });

  it("adds clear-filter button (ppage + empty tagSid) when tagFilter is set", () => {
    const tags = [{ tag: "review", count: 1 }];
    const card = JSON.stringify(
      promptsCard(oneItem, tags, { page: 0, totalPages: 1, tagFilter: "review" }),
    );
    // clear-filter button uses ppage cmd with empty tagSid
    expect(card).toContain("ppage");
  });

  it("renders ◀ prev button when page > 0", () => {
    const items = Array.from({ length: 1 }, (_, i) => ({
      name: `p${i}`,
      tags: [],
      description: "",
      snippet: "",
    }));
    const card = JSON.stringify(promptsCard(items, [], { page: 1, totalPages: 3, tagFilter: "" }));
    expect(card).toContain("◀");
  });

  it("renders ▶ next button when page < totalPages - 1", () => {
    const items = [{ name: "p0", tags: [], description: "", snippet: "" }];
    const card = JSON.stringify(promptsCard(items, [], { page: 0, totalPages: 2, tagFilter: "" }));
    expect(card).toContain("▶");
  });

  it("no paging buttons on single page", () => {
    const card = JSON.stringify(
      promptsCard(oneItem, [], { page: 0, totalPages: 1, tagFilter: "" }),
    );
    expect(card).not.toContain("◀");
    expect(card).not.toContain("▶");
  });

  it("omits tag row when tags array is empty", () => {
    const card = JSON.stringify(
      promptsCard(oneItem, [], { page: 0, totalPages: 1, tagFilter: "" }),
    );
    expect(card).not.toContain("pfilter");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// card-actions.ts — pget / pfilter / ppage handlers
// ────────────────────────────────────────────────────────────────────────────

describe("card-actions pget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pget in non-p2p → no-op", async () => {
    const channel = fakeChannel();
    channel.setChatType("group");
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pget", sid: sessionShortId("code-review") }));
    // Group chats are not serviceable unless bound; getChatInfo returns "group"
    // so the whole card-action is dropped before reaching pget.
    expect(channel.texts()).toHaveLength(0);
  });

  it("pget when lib disabled → promptsDisabled text", async () => {
    const channel = fakeChannel();
    // channel.getChatInfo returns p2p (default)
    const deps = fakeDeps({ config: disabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pget", sid: sessionShortId("code-review") }));
    expect(channel.texts().some((t) => t.includes("未启用"))).toBe(true);
  });

  it("pget with valid sid → sends prompt body as code block", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_ONE; // for resolvePromptByShortId
      if (tool === "get_prompt") return GET_BODY;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pget", sid: sessionShortId("code-review") }));
    expect(channel.texts().some((t) => t.includes("code-review") || t.includes("审查"))).toBe(true);
  });

  it("pget with unknown sid → promptsGone text", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "search_prompts") return SEARCH_EMPTY; // no prompts found
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pget", sid: "zzzzzzzzzz" }));
    expect(channel.texts().some((t) => t.includes("不存在"))).toBe(true);
  });

  it("pget throws → promptsError text", async () => {
    fakeCallerFn.mockRejectedValue(new Error("boom"));
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pget", sid: sessionShortId("code-review") }));
    expect(channel.texts().some((t) => t.includes("连接失败"))).toBe(true);
  });
});

describe("card-actions pfilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pfilter when lib disabled → promptsDisabled text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: disabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pfilter", tagSid: sessionShortId("review") }));
    expect(channel.texts().some((t) => t.includes("未启用"))).toBe(true);
  });

  it("pfilter with valid tagSid → re-renders browse card filtered by tag", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "list_prompt_tags") return TAGS_ONE;
      if (tool === "search_prompts") return SEARCH_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pfilter", tagSid: sessionShortId("review") }));
    // Should produce a browse card (not just text)
    expect(channel.cards()).toHaveLength(1);
  });

  it("pfilter throws → promptsError text", async () => {
    fakeCallerFn.mockRejectedValue(new Error("fail"));
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "pfilter", tagSid: sessionShortId("review") }));
    expect(channel.texts().some((t) => t.includes("连接失败"))).toBe(true);
  });
});

describe("card-actions ppage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ppage when lib disabled → promptsDisabled text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: disabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "ppage", page: 1, tagSid: "" }));
    expect(channel.texts().some((t) => t.includes("未启用"))).toBe(true);
  });

  it("ppage with page+tag → re-renders browse card at requested page", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "list_prompt_tags") return TAGS_ONE;
      if (tool === "search_prompts") return SEARCH_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "ppage", page: 0, tagSid: "" }));
    expect(channel.cards()).toHaveLength(1);
  });

  it("ppage with non-empty tagSid resolves the tag name", async () => {
    fakeCallerFn.mockImplementation(async (tool) => {
      if (tool === "list_prompt_tags") return TAGS_ONE;
      if (tool === "search_prompts") return SEARCH_ONE;
      return "";
    });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "ppage", page: 0, tagSid: sessionShortId("review") }));
    expect(channel.cards()).toHaveLength(1);
    const card = JSON.stringify(channel.cards()[0]);
    // The re-rendered card should have the tag filter applied (✅ on "review")
    expect(card).toContain("✅");
  });

  it("ppage throws → promptsError text", async () => {
    fakeCallerFn.mockRejectedValue(new Error("fail"));
    const channel = fakeChannel();
    const deps = fakeDeps({ config: enabledPromptConfig() });
    const handle = makeCardActionHandler(channel, deps);
    await handle(cardEvt({ cmd: "ppage", page: 0, tagSid: "" }));
    expect(channel.texts().some((t) => t.includes("连接失败"))).toBe(true);
  });
});
