import { afterEach, describe, expect, it, vi } from "vitest";
import { handleNewFreeCommand } from "../../src/adapters/telegram/handlers.js";
import * as ops from "../../src/core/project-ops.js";

afterEach(() => vi.restoreAllMocks());

describe("handleNewFreeCommand", () => {
  it("creates a free project and replies success", async () => {
    vi.spyOn(ops, "createFreeProject").mockResolvedValue({
      status: "created",
      sessionName: "tmux_proj_free_1",
      slot: 1,
    });
    const replies: Array<{ kind: string; text: string }> = [];
    const ctx = { message: { text: "/new_free feature-x" } } as never;
    await handleNewFreeCommand(ctx, {} as never, "telegram:1", (kind, text) => {
      replies.push({ kind, text });
    });
    expect(replies[0]?.text).toContain("🆓");
    expect(replies[0]?.text).toContain("#1");
  });

  it("replies the limit message when full", async () => {
    vi.spyOn(ops, "createFreeProject").mockResolvedValue({ status: "limit" });
    const replies: Array<{ kind: string; text: string }> = [];
    const ctx = { message: { text: "/new_free" } } as never;
    await handleNewFreeCommand(ctx, {} as never, "telegram:1", (kind, text) => {
      replies.push({ kind, text });
    });
    expect(replies[0]?.kind).toBe("err");
    expect(replies[0]?.text).toContain("10");
  });
});
