import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCardActionHandler } from "../../../src/adapters/lark/card-actions.js";
import { sessionShortId } from "../../../src/shared/utils/hash.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

// Keep the real VOICE_LANGS/resolveWhisperLanguage; stub the .env writer.
vi.mock("../../../src/core/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/voice-support.js")>()),
  persistEnvVar: vi.fn(),
}));

function evt(value: unknown, over: Partial<CardActionEvent> = {}): CardActionEvent {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    operator: { openId: "ou_me" },
    action: { value, tag: "button" },
    ...over,
  } as CardActionEvent;
}

describe("makeCardActionHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("voicelangmenu → sends the voice-language picker card", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "voicelangmenu" }));
    expect(channel.cards().some((c) => JSON.stringify(c).includes("语音识别语言"))).toBe(true);
  });

  it("voicelang → sets WHISPER_LANGUAGE and re-sends the picker", async () => {
    const prev = process.env.LARK_WHISPER_LANGUAGE;
    try {
      const channel = fakeChannel();
      const handle = makeCardActionHandler(channel, fakeDeps());
      await handle(evt({ cmd: "voicelang", lang: "yue" }));
      expect(process.env.LARK_WHISPER_LANGUAGE).toBe("yue");
      expect(channel.cards().some((c) => JSON.stringify(c).includes("语音识别语言"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LARK_WHISPER_LANGUAGE;
      else process.env.LARK_WHISPER_LANGUAGE = prev;
    }
  });

  it("drops cardAction from a non-allowlisted operator", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "help" }, { operator: { openId: "ou_stranger" } }));

    expect(channel.sent).toHaveLength(0);
  });

  it("a card with no cmd is inert", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({}));

    expect(channel.sent).toHaveLength(0);
  });

  it("'noop' is inert", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "noop" }));

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("'help' sends the help card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "help" }));

    expect(channel.cards()).toHaveLength(1);
  });

  // peek/listalive/recent render cards; current/queuestatus render text. history
  // renders a card only when the session has a path mapping (otherwise a "缺少路径"
  // text hint) — covered separately in views.test.ts, so it's excluded here.
  it.each([
    ["peek", "card"],
    ["listalive", "card"],
    ["recent", "card"],
    ["current", "text"],
    ["queuestatus", "text"],
  ])("'%s' routes to its view fn (%s output)", async (cmd, kind) => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd }));

    if (kind === "card") {
      expect(channel.cards().length).toBeGreaterThanOrEqual(1);
    } else {
      expect(channel.texts().length).toBeGreaterThanOrEqual(1);
    }
  });

  it("'history' routes to sendHistory (replies the path-mapping hint here)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "history" }));

    expect(channel.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
  });

  it("'switch' with a matching sid switches to that project", async () => {
    const session = "tmux_proj_alpha";
    const sid = sessionShortId(session);
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "switch", sid }));

    expect(deps.currentProject.set).toHaveBeenCalledWith("lark", session);
    expect(channel.texts().some((t) => t.includes("已切换"))).toBe(true);
  });

  it("'remove' with a matching sid removes that project", async () => {
    const session = "tmux_proj_beta";
    const sid = sessionShortId(session);
    const channel = fakeChannel();
    const deps = fakeDeps({
      session: "other",
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      claude: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid }));

    expect(deps.bridge.killSession).toHaveBeenCalledWith(session);
    expect(channel.texts().some((t) => t.includes("已移除"))).toBe(true);
  });

  it("'switch' with an unmatched sid does nothing observable", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => ["tmux_proj_x"]) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "switch", sid: "zzzzzz" }));

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
  });

  it("'addrecent' with a sid routes to addRecentBySid", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    // No recent lines match → replies the "未找到短 id" message; that's enough to
    // prove the addrecent branch was taken.
    await handler(evt({ cmd: "addrecent", sid: "nomatch" }));

    expect(channel.texts().some((t) => t.includes("未找到短 id"))).toBe(true);
  });

  it("an IMMEDIATE cmd runs immediately (no enqueue, plain text)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "status" }));

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(channel.texts().some((t) => t.includes("运行中"))).toBe(true);
  });

  it("a QUEUED cmd is enqueued", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "restart" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("restart");
  });

  it("an unknown cmd is inert", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "totally-unknown" }));

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });
});
