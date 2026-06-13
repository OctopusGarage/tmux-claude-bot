import { describe, expect, it, vi } from "vitest";
import { fakeDeps } from "../lark/_fakes.js";

// Observable collaborators of runPromptWithProgress. We record the progress
// handle + typing teardown so the test can assert the lifecycle is cleaned up.
const finalize = vi.fn(async () => true);
const update = vi.fn(async () => {});
const stopTyping = vi.fn();

vi.mock("../../../src/adapters/telegram/progress.js", () => ({
  startProgress: vi.fn(async () => ({ messageId: 42, update, finalize })),
}));
vi.mock("../../../src/adapters/telegram/typing.js", () => ({
  startTyping: vi.fn(() => stopTyping),
}));
vi.mock("../../../src/adapters/telegram/reactions.js", () => ({
  REACTION: { received: "👀", done: "👍", failed: "😱" },
  reactToMessage: vi.fn(async () => {}),
}));
vi.mock("../../../src/adapters/telegram/replies.js", () => ({
  reply: vi.fn(async () => {}),
  composeMessage: (_kind: string, text: string) => ({ text, extra: {} }),
}));

import { runPromptWithProgress } from "../../../src/adapters/telegram/prompt-lifecycle.js";

function fakeCtx() {
  return {
    chat: { id: 123 },
    message: { message_id: 5 },
    api: {},
  } as unknown as Parameters<typeof runPromptWithProgress>[0];
}

const replyTarget = { record: vi.fn() } as unknown as Parameters<typeof runPromptWithProgress>[4];

describe("runPromptWithProgress — duplicate enqueue", () => {
  it("tears down the typing indicator and progress ticker when the prompt is deduped", async () => {
    // Regression: enqueue() returns the TRUTHY string "duplicate" when an identical
    // prompt is already queued. The old `if (!queued)` treated it as success, so
    // resolve/reject never fired, cleanup() never ran, and the typing indicator +
    // 5s elapsed-time ticker leaked forever with the user getting no answer.
    finalize.mockClear();
    stopTyping.mockClear();
    const deps = fakeDeps({ queue: { enqueue: vi.fn(() => "duplicate" as const) } });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget);

    expect(stopTyping).toHaveBeenCalledTimes(1); // typing indicator stopped
    expect(finalize).toHaveBeenCalledTimes(1); // "processing…" placeholder replaced, not left ticking
  });
});
