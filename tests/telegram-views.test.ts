import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createReplyTargetMap } from "../src/adapters/telegram/reply-target.js";
import { browseText, replyCreateProject, sendAliveList } from "../src/adapters/telegram/views.js";
import { messages } from "../src/core/i18n/index.js";
import type { BrowseView } from "../src/core/projects/dir-browser.js";
import { chatScope } from "../src/core/projects/project-manager.js";
import type { CreateProjectResult } from "../src/core/projects/project-ops.js";
import { setPathForSession } from "../src/core/projects/sessionPathMap.js";
import { fakeDeps } from "./adapters/lark/_fakes.js";

type Button = { text: string; callback_data?: string };

function fakeCtx(chatId: number) {
  const replies: { text: string; extra?: { reply_markup?: { inline_keyboard: Button[][] } } }[] =
    [];
  const ctx = {
    chat: { id: chatId },
    reply: vi.fn(async (text: string, extra?: unknown) => {
      replies.push({ text, extra: extra as never });
      return { message_id: 1 };
    }),
  } as unknown as Context;
  return { ctx, replies };
}

describe("sendAliveList (telegram)", () => {
  it("marks the chat-scoped current project active — not the legacy bare-channel one", async () => {
    const dirA = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-proj-a-"));
    const dirB = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-proj-b-"));
    setPathForSession("tmux_proj_alive_a", dirA);
    setPathForSession("tmux_proj_alive_b", dirB);

    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => ["tmux_proj_alive_a", "tmux_proj_alive_b"]),
      },
      currentProject: {
        // Stale legacy key still points at A; this chat actually switched to B.
        get: vi.fn(async (scope: string) => {
          if (scope === chatScope("telegram", "123")) return "tmux_proj_alive_b";
          if (scope === "telegram") return "tmux_proj_alive_a";
          return null;
        }),
      },
    });

    const { ctx, replies } = fakeCtx(123);
    await sendAliveList(ctx, deps);

    const buttons = replies[0]?.extra?.reply_markup?.inline_keyboard.flat() ?? [];
    const active = buttons.filter((b) => b.callback_data === "noop");
    const switchable = buttons.filter((b) => b.callback_data?.startsWith("s:"));

    // B (the chat's real current project) is the inert ✅ row…
    expect(active).toHaveLength(1);
    expect(active[0]?.text).toContain(nodePath.basename(dirB));
    // …and A must stay switchable — with the legacy read it was wrongly inert.
    expect(switchable.map((b) => b.text).join()).toContain(nodePath.basename(dirA));
  });
});

describe("browseText (telegram)", () => {
  const m = messages("telegram");
  const base = {
    entries: [] as { label: string; index: number; isRepo: boolean }[],
    canGoUp: false,
    canCreate: true,
    page: 0,
    totalPages: 1,
  };

  it("roots screen shows the pick-a-root title", () => {
    const v: BrowseView = { ...base, kind: "roots", displayPath: "", cwd: null };
    expect(browseText(v)).toBe(m.browseRootsTitle);
  });

  it("dir screen shows the breadcrumb, plus an empty/unreadable note", () => {
    const dir = (over: Partial<BrowseView>): BrowseView => ({
      ...base,
      kind: "dir",
      displayPath: "~/p",
      cwd: "/home/u/p",
      ...over,
    });
    expect(browseText(dir({ entries: [{ label: "a", index: 0, isRepo: false }] }))).toContain(
      "~/p",
    );
    expect(browseText(dir({ error: "unreadable" }))).toContain(m.browseUnreadable);
    expect(browseText(dir({ entries: [] }))).toContain(m.browseEmpty);
  });
});

describe("replyCreateProject (telegram)", () => {
  const replyTarget = createReplyTargetMap(`/tmp/tg-rcp-rt-${Date.now()}`);
  const run = async (result: CreateProjectResult) => {
    const { ctx, replies } = fakeCtx(7);
    await replyCreateProject(ctx, fakeDeps(), result, replyTarget);
    return replies;
  };

  it("maps each invalid reason to a reply", async () => {
    expect(
      await run({ status: "invalid", error: "not-a-directory", resolvedPath: "/p" }),
    ).toHaveLength(1);
    expect(await run({ status: "invalid", error: "not-found", resolvedPath: "/p" })).toHaveLength(
      1,
    );
    expect(await run({ status: "invalid", error: "not-allowed", resolvedPath: "/p" })).toHaveLength(
      1,
    );
  });

  it("maps switched / created / error outcomes to a reply", async () => {
    expect(await run({ status: "switched", sessionName: "s", projectPath: "/p" })).toHaveLength(1);
    // created → the "created" confirmation PLUS the start/pick step (single
    // configured command here, so it auto-starts and replies "started").
    expect(await run({ status: "created", sessionName: "s", projectPath: "/p" })).toHaveLength(2);
    expect(await run({ status: "error", message: "boom" })).toHaveLength(1);
  });

  it("created with multiple start commands shows the flavor picker", async () => {
    const { ctx, replies } = fakeCtx(7);
    const deps = fakeDeps({
      config: {
        startCommands: [
          { label: "claude-stella", command: "claude-stella" },
          { label: "claude-yolo", command: "claude-yolo" },
        ],
      },
    });
    await replyCreateProject(
      ctx,
      deps,
      { status: "created", sessionName: "s", projectPath: "/p" },
      replyTarget,
    );
    expect(replies).toHaveLength(2); // created confirmation + picker
    expect(replies[1]?.extra?.reply_markup).toBeDefined();
  });
});
