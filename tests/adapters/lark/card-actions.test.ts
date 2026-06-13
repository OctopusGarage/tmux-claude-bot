import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCardActionHandler } from "../../../src/adapters/lark/card-actions.js";
import { bindGroup, getBinding, unbindGroup } from "../../../src/core/group-bindings.js";
import { appendRecentProject } from "../../../src/core/recentProjects.js";
import { sessionNameFromPath } from "../../../src/core/sessionPathMap.js";
import { sessionShortId } from "../../../src/shared/utils/hash.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

// Keep the real VOICE_LANGS/resolveWhisperLanguage; stub the .env writer and the
// host-mutating install so `voiceinstall` is exercisable without a real install.
const installVoiceMock = vi.fn(
  async (): Promise<{ status: string; bin?: string; message?: string }> => ({
    status: "ok",
    bin: "/x/mlx_whisper",
  }),
);
vi.mock("../../../src/core/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/voice-support.js")>()),
  persistEnvVar: vi.fn(),
  checkVoiceSupport: vi.fn(() => ({ ready: false, reason: "not-installed" })),
  isVoicePlatformSupported: vi.fn(() => true),
  installVoice: () => installVoiceMock(),
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

  it("voicelangmenu → sends the voice-language picker as a managed card", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "voicelangmenu" }));
    expect(channel.cardkitCreates.some((c) => c.data.data.includes("语音识别语言"))).toBe(true);
    expect(channel.imCreates).toHaveLength(1);
  });

  it("voiceinstall → runs the core install and replies the result (Feishu parity with Telegram)", async () => {
    installVoiceMock.mockResolvedValueOnce({ status: "ok", bin: "/x/mlx_whisper" });
    const channel = fakeChannel();
    await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "voiceinstall" }));
    expect(installVoiceMock).toHaveBeenCalled();
    // acks "installing…" then reports success
    expect(channel.texts().some((t) => t.includes("正在安装"))).toBe(true);
    expect(channel.texts().some((t) => t.includes("已就绪"))).toBe(true);
  });

  it("voiceinstall → surfaces a failure result", async () => {
    installVoiceMock.mockResolvedValueOnce({ status: "failed", message: "boom" });
    const channel = fakeChannel();
    await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "voiceinstall" }));
    expect(channel.texts().some((t) => t.includes("boom"))).toBe(true);
  });

  it("voicelang on a managed picker → sets WHISPER_LANGUAGE and updates the card in place", async () => {
    const prev = process.env.LARK_WHISPER_LANGUAGE;
    try {
      const channel = fakeChannel();
      const handle = makeCardActionHandler(channel, fakeDeps());
      await handle(evt({ cmd: "voicelangmenu" }));
      const pickerMessageId = "im-m1";

      await handle(evt({ cmd: "voicelang", lang: "yue" }, { messageId: pickerMessageId }));

      expect(process.env.LARK_WHISPER_LANGUAGE).toBe("yue");
      expect(channel.cardkitUpdates).toHaveLength(1);
      expect(channel.cardkitUpdates.some((u) => u.data.card.data.includes("语音识别语言"))).toBe(
        true,
      );
      // In place: no second message was sent.
      expect(channel.imCreates).toHaveLength(1);
      expect(channel.sent).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.LARK_WHISPER_LANGUAGE;
      else process.env.LARK_WHISPER_LANGUAGE = prev;
    }
  });

  it("voicelang on an unmanaged message → falls back to sending a fresh picker", async () => {
    const prev = process.env.LARK_WHISPER_LANGUAGE;
    try {
      const channel = fakeChannel();
      const handle = makeCardActionHandler(channel, fakeDeps());

      await handle(evt({ cmd: "voicelang", lang: "yue" }, { messageId: "msg-pre-restart" }));

      expect(process.env.LARK_WHISPER_LANGUAGE).toBe("yue");
      expect(channel.cardkitUpdates).toHaveLength(0);
      expect(channel.cardkitCreates.some((c) => c.data.data.includes("语音识别语言"))).toBe(true);
      expect(channel.imCreates).toHaveLength(1);
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

    expect(deps.currentProject.set).toHaveBeenCalledWith("lark:chat-1", session);
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

  it("'remove' in a bound group is refused with a hint — manage projects in private chat", async () => {
    bindGroup("oc_grp_bound", { workspacePath: "/p/g", sessionName: "tmux_proj_g", label: "g" });
    const session = "tmux_proj_beta";
    const channel = fakeChannel();
    channel.setChatType("group");
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      claude: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid: sessionShortId(session) }, { chatId: "oc_grp_bound" }));

    expect(deps.bridge.killSession).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("不能删除项目"))).toBe(true);
    unbindGroup("oc_grp_bound");
  });

  it("a card action in an unbound (lost-binding) group is ignored — buttons do nothing", async () => {
    const session = "tmux_proj_beta";
    const channel = fakeChannel();
    // No binding for this group, and it's a real group chat. Mirrors how text
    // is ignored in unbound groups — stale buttons must not act either.
    channel.setChatType("group");
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      claude: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid: sessionShortId(session) }, { chatId: "oc_grp_rm" }));

    expect(deps.bridge.killSession).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0); // silent, like an ignored text message
  });

  it("a card action is ignored when the chat type can't be resolved (fail safe)", async () => {
    const session = "tmux_proj_beta";
    const channel = fakeChannel();
    channel.getChatInfo = vi.fn(async () => {
      throw new Error("network");
    });
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      claude: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid: sessionShortId(session) }, { chatId: "oc_unknown" }));

    expect(deps.bridge.killSession).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
  });

  it("'switch' in a bound group is pinned — refuses and does not change project", async () => {
    bindGroup("oc_pinned", { workspacePath: "/p/pin", sessionName: "tmux_proj_pin", label: "pin" });
    const session = "tmux_proj_alpha";
    const channel = fakeChannel();
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => [session]) } });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "switch", sid: sessionShortId(session) }, { chatId: "oc_pinned" }));

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("已固定绑定"))).toBe(true);
    unbindGroup("oc_pinned"); // bindings are a module singleton over the shared temp dir
  });

  it("'addrecent' in a bound group is pinned — refuses, no project change", async () => {
    bindGroup("oc_pinned2", {
      workspacePath: "/p/pin",
      sessionName: "tmux_proj_pin",
      label: "pin",
    });
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "addrecent", sid: "whatever" }, { chatId: "oc_pinned2" }));

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("已固定绑定"))).toBe(true);
    unbindGroup("oc_pinned2");
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

  it("uilangmenu → sends the UI-language picker as a managed card", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "uilangmenu" }));
    expect(channel.cardkitCreates).toHaveLength(1);
    expect(channel.imCreates).toHaveLength(1);
  });

  it("uilang with a valid lang on a managed picker → sets UI language and updates in place", async () => {
    const prev = process.env.LARK_UI_LANG;
    try {
      const channel = fakeChannel();
      const handle = makeCardActionHandler(channel, fakeDeps());
      await handle(evt({ cmd: "uilangmenu" }));

      await handle(evt({ cmd: "uilang", lang: "en" }, { messageId: "im-m1" }));

      expect(process.env.LARK_UI_LANG).toBe("en");
      expect(channel.cardkitUpdates).toHaveLength(1);
      expect(channel.imCreates).toHaveLength(1);
      expect(channel.sent).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.LARK_UI_LANG;
      else process.env.LARK_UI_LANG = prev;
    }
  });

  it("uilang on an unmanaged message → falls back to sending a fresh picker", async () => {
    const prev = process.env.LARK_UI_LANG;
    try {
      const channel = fakeChannel();
      const handle = makeCardActionHandler(channel, fakeDeps());

      await handle(evt({ cmd: "uilang", lang: "en" }, { messageId: "msg-pre-restart" }));

      expect(process.env.LARK_UI_LANG).toBe("en");
      expect(channel.cardkitUpdates).toHaveLength(0);
      expect(channel.cardkitCreates).toHaveLength(1);
      expect(channel.imCreates).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.LARK_UI_LANG;
      else process.env.LARK_UI_LANG = prev;
    }
  });

  it("uilang with an unrecognised lang → no-op (isUiLang returns false)", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "uilang", lang: "klingon" }));
    expect(channel.sent).toHaveLength(0);
  });

  // --- project-group buttons ---
  describe("project-group buttons", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tcb-ca-grp-"));
      process.env.TCB_STATE_DIR = dir;
    });
    afterEach(() => {
      delete process.env.TCB_STATE_DIR;
      rmSync(dir, { recursive: true, force: true });
    });

    it("groupmenu in a non-bound chat → sends the new-group picker", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "groupmenu" }));
      expect(JSON.stringify(channel.cards())).toContain("新建项目群");
    });

    it("groupmenu in a bound group → sends the bound-group management card", async () => {
      bindGroup("chat-1", { workspacePath: dir, sessionName: "s", label: "projZ" });
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "groupmenu" }));
      expect(JSON.stringify(channel.cards())).toContain("projZ");
    });

    it("rebind → sends the bind picker", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "rebind" }));
      expect(JSON.stringify(channel.cards())).toContain("绑定本群");
    });

    it("unbind → removes the binding and confirms", async () => {
      bindGroup("chat-1", { workspacePath: dir, sessionName: "s", label: "projZ" });
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "unbind" }));
      expect(getBinding("chat-1")).toBeNull();
      expect(channel.texts().some((t) => t.includes("已解除"))).toBe(true);
    });

    it("restore → re-anchors and confirms", async () => {
      bindGroup("chat-1", { workspacePath: dir, sessionName: "s", label: "projZ" });
      const channel = fakeChannel();
      const deps = fakeDeps({
        bridge: { hasSession: vi.fn(async () => true) },
        currentProject: { get: vi.fn(async () => "s") },
      });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "restore" }));
      expect(channel.texts().some((t) => t.includes("已恢复"))).toBe(true);
    });

    it("bindhere in a bound group → rebinds the current group to that recent project", async () => {
      // bindhere is reached only from a bound group's rebind picker, so the
      // chat is already a project group; bindhere re-anchors it elsewhere.
      bindGroup("chat-1", { workspacePath: "/old", sessionName: "s-old", label: "old" });
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      const channel = fakeChannel();
      await makeCardActionHandler(channel, deps)(evt({ cmd: "bindhere", sid }));
      expect(getBinding("chat-1")?.workspacePath).toBe(dir);
    });

    it("bindhere in a private chat → refused (group only), no binding written", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      const channel = fakeChannel(); // default chat type p2p, chat-1 not bound
      await makeCardActionHandler(channel, deps)(evt({ cmd: "bindhere", sid }));
      expect(getBinding("chat-1")).toBeNull();
      expect(channel.texts().some((t) => t.includes("群"))).toBe(true);
    });
  });

  // --- multi-command start picker ---
  describe("start picker", () => {
    const multi = {
      config: {
        startCommands: [
          { label: "A", command: "echo" },
          { label: "B", command: "bash" },
        ],
      },
    };

    it("start with >1 command → sends the picker instead of starting", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps(multi);
      await makeCardActionHandler(channel, deps)(evt({ cmd: "start" }));
      expect(JSON.stringify(channel.cards())).toContain("选择启动方式");
      expect(deps.claude.start).not.toHaveBeenCalled();
    });

    it("startpick → starts the chosen command and confirms", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps(multi);
      await makeCardActionHandler(channel, deps)(evt({ cmd: "startpick", idx: 1 }));
      expect(deps.claude.start).toHaveBeenCalledWith("proj-1", "bash");
      expect(channel.texts().some((t) => t.includes("B"))).toBe(true);
    });
  });
});
