import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { sendAliveList } from "../src/adapters/telegram/views.js";
import { chatScope } from "../src/core/project-manager.js";
import { setPathForSession } from "../src/core/sessionPathMap.js";
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
