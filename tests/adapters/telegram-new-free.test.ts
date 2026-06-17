import { afterEach, describe, expect, it, vi } from "vitest";
import { handleNewFreeCommand } from "../../src/adapters/telegram/handlers.js";
import * as ops from "../../src/core/projects/project-ops.js";

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

  it("returns the new session name on success (so the caller can start/pick)", async () => {
    vi.spyOn(ops, "createFreeProject").mockResolvedValue({
      status: "created",
      sessionName: "tmux_proj_free_2",
      slot: 2,
    });
    const ctx = { message: { text: "/new_free x" } } as never;
    const session = await handleNewFreeCommand(ctx, {} as never, "telegram:1", () => {});
    expect(session).toBe("tmux_proj_free_2");
  });

  it("returns null when not created", async () => {
    vi.spyOn(ops, "createFreeProject").mockResolvedValue({ status: "limit" });
    const ctx = { message: { text: "/new_free" } } as never;
    const session = await handleNewFreeCommand(ctx, {} as never, "telegram:1", () => {});
    expect(session).toBeNull();
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
