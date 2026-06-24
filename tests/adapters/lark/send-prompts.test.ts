import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the deepest seam (the MCP call) and the reply sinks, so sendPrompts +
// the real makePromptLib + promptsCard all execute and coverage is attributed.
// vi.hoisted lets the hoisted vi.mock factories reference these mocks safely.
const { callPromptTool, sendText, sendCard } = vi.hoisted(() => ({
  callPromptTool: vi.fn(),
  sendText: vi.fn(async () => {}),
  sendCard: vi.fn(async () => {}),
}));
vi.mock("../../../src/core/promptlib/client.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/core/promptlib/client.js")>()),
  callPromptTool,
}));

vi.mock("../../../src/adapters/lark/replies.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/adapters/lark/replies.js")>()),
  sendText,
  sendCard,
}));

import { sendPrompts } from "../../../src/adapters/lark/prompts.js";
import { messages } from "../../../src/core/i18n/index.js";

const channel = {} as never;
const m = messages("lark");
const depsWith = (command: string) => ({ config: { promptMcp: { command, args: [] } } }) as never;

beforeEach(() => {
  for (const f of [callPromptTool, sendText, sendCard]) f.mockClear();
  callPromptTool.mockImplementation(async (_cfg: unknown, tool: string) => {
    if (tool === "search_prompts")
      return "找到 1 条:\n• code-review  [review] — 审查\n    审查改动";
    if (tool === "list_prompt_tags") return "标签:\n  review (1)";
    return "";
  });
});

describe("sendPrompts (lark)", () => {
  it("sends the disabled notice when the prompt lib is not configured", async () => {
    await sendPrompts(channel, depsWith(""), "c1", undefined);
    expect(sendText).toHaveBeenCalledWith(channel, "c1", m.promptsDisabled);
    expect(callPromptTool).not.toHaveBeenCalled();
  });

  it("renders a search-result card when an arg matches", async () => {
    await sendPrompts(channel, depsWith("uv"), "c1", "code");
    expect(callPromptTool).toHaveBeenCalledWith(
      expect.anything(),
      "search_prompts",
      expect.objectContaining({ query: "code" }),
    );
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sends promptsEmpty when a search arg matches nothing", async () => {
    callPromptTool.mockResolvedValueOnce(""); // empty search result
    await sendPrompts(channel, depsWith("uv"), "c1", "nope");
    expect(sendText).toHaveBeenCalledWith(channel, "c1", m.promptsEmpty);
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("renders the browse card when there is no arg and prompts exist", async () => {
    await sendPrompts(channel, depsWith("uv"), "c1", undefined);
    expect(sendCard).toHaveBeenCalledTimes(1);
  });

  it("sends promptsEmpty when the browse page is empty", async () => {
    callPromptTool.mockResolvedValue(""); // both search + tags empty
    await sendPrompts(channel, depsWith("uv"), "c1", undefined);
    expect(sendText).toHaveBeenCalledWith(channel, "c1", m.promptsEmpty);
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("sends promptsError when the MCP call throws", async () => {
    callPromptTool.mockRejectedValue(new Error("boom"));
    await sendPrompts(channel, depsWith("uv"), "c1", undefined);
    expect(sendText).toHaveBeenCalledWith(channel, "c1", m.promptsError);
  });
});
