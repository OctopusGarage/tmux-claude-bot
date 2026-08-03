import { beforeEach, describe, expect, it, vi } from "vitest";

// Avoid touching the real .env in the voice-language branch; keep VOICE_LANGS etc.
vi.mock("../../../src/core/read/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/voice-support.js")>()),
  persistEnvVar: vi.fn(),
}));

// The UI-language pick persists via env-store — don't touch a real .env.
vi.mock("../../../src/core/infra/env-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/infra/env-store.js")>()),
  persistEnvVar: vi.fn(),
}));

// The adopt branches (as:/ae:) scan live processes — stub them deterministically.
vi.mock("../../../src/core/agents/takeover-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/agents/takeover-service.js")>()),
  findAdoptableOrphans: vi.fn(async () => []),
  adoptOrphan: vi.fn(async () => null),
}));

vi.mock("../../../src/core/platform/clipboard.js", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

vi.mock("../../../src/core/autopilot/delegated-task.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/core/autopilot/delegated-task.js")>();
  return {
    ...actual,
    startActiveDelegatedTask: vi.fn(async () => ({
      status: "queued",
      runId: "run-ap-confirm",
      projectId: "cbtest",
      supervisorSession: "tmux_proj_loop-supervisor",
      reportDir: "/tmp/run-ap-confirm",
    })),
  };
});

// The recover branch sweeps the live roster — stub the planner/executor.
vi.mock("../../../src/core/recovery/recover.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/recovery/recover.js")>()),
  recoverProjects: vi.fn(async () => ({
    launched: [],
    shellOnly: [],
    alreadyAlive: [],
    skippedMissingDir: [],
    failed: [],
    busy: false,
  })),
}));

// The status-install branch reads/writes ~/.claude — stub the view it renders.
vi.mock("../../../src/adapters/telegram/views.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/adapters/telegram/views.js")>();
  return { ...actual, sendStatusInstall: vi.fn(async () => {}) };
});

import { handleCallbackQuery } from "../../../src/adapters/telegram/callbacks.js";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";
import { sendStatusInstall } from "../../../src/adapters/telegram/views.js";
import { adoptOrphan, findAdoptableOrphans } from "../../../src/core/agents/takeover-service.js";
import { startActiveDelegatedTask } from "../../../src/core/autopilot/delegated-task.js";
import { copyToClipboard } from "../../../src/core/platform/clipboard.js";
import { storeInputList } from "../../../src/core/read/recent-inputs.js";
import { recoverProjects } from "../../../src/core/recovery/recover.js";
import { sessionShortId } from "../../../src/shared/utils/hash.js";
import { fakeCtx, fakeDeps } from "./_fakes.js";

const adoptOrphanMock = vi.mocked(adoptOrphan);
const findAdoptableOrphansMock = vi.mocked(findAdoptableOrphans);
const recoverProjectsMock = vi.mocked(recoverProjects);
const sendStatusInstallMock = vi.mocked(sendStatusInstall);
const startActiveDelegatedTaskMock = vi.mocked(startActiveDelegatedTask);

const SESSION = "tmux_proj_cbtest";
const SID = sessionShortId(SESSION);

const replyTarget = createReplyTargetMap(`/tmp/tg-cb-rt-${Date.now()}`);

/** deps where listProjectSessions returns our test session (so sid resolves). */
function aliveDeps(over: Parameters<typeof fakeDeps>[0] = {}) {
  const { bridge, ...rest } = over;
  return fakeDeps({
    ...rest,
    bridge: { listProjectSessions: vi.fn(async () => [SESSION]), ...bridge },
  });
}

describe("handleCallbackQuery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers (no-op) when callback_data does not parse", async () => {
    const ctx = fakeCtx({ callbackData: "garbage-data" });
    const deps = fakeDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.editedMarkups).toHaveLength(0);
  });

  it("more/less swap the control keyboard in place", async () => {
    const ctx = fakeCtx({ callbackData: `m:${SID}` });
    const deps = fakeDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.answered).toContain(undefined);
    expect(ctx.editedMarkups).toHaveLength(1);
  });

  it("delmode/dellist re-fetch the project list and swap the keyboard", async () => {
    const ctx = fakeCtx({ callbackData: "dm" });
    const deps = aliveDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(deps.bridge.listProjectSessions).toHaveBeenCalled();
    expect(ctx.editedMarkups).toHaveLength(1);
  });

  it("listalive (la) renders the alive list view", async () => {
    const ctx = fakeCtx({ callbackData: "la" });
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.texts().some((t) => t.includes("没有活跃会话"))).toBe(true);
  });

  it("queuestatus (qs) renders the queue-status view", async () => {
    const ctx = fakeCtx({ callbackData: "qs" });
    const deps = fakeDeps({
      queue: { getGlobalQueue: vi.fn(() => []), getSessionNames: vi.fn(() => []) },
    });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.texts().some((t) => t.includes("队列状态"))).toBe(true);
  });

  it("dangerous control button asks for confirmation before executing", async () => {
    const exit = vi.fn(async () => {});
    const ctx = fakeCtx({ callbackData: `a:exit:${SID}` });
    const deps = aliveDeps({ agent: { exit } });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(exit).not.toHaveBeenCalled();
    expect(ctx.texts().some((t) => t.includes("确认") && t.includes("退出"))).toBe(true);
    expect(JSON.stringify(ctx.replies)).toContain(`cf:exit:${SID}`);
  });

  it("confirmed dangerous control button enqueues the original action", async () => {
    const exit = vi.fn(async () => {});
    const ctx = fakeCtx({ callbackData: `cf:exit:${SID}` });
    const deps = aliveDeps({ agent: { exit } });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(exit).not.toHaveBeenCalled();
    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]).toMatchObject({ sessionName: SESSION, action: "exit" });
    expect(ctx.texts().some((t) => t.includes("已接收"))).toBe(true);
  });

  it("ap_plan previews the delegation plan without starting supervisor work", async () => {
    const ctx = fakeCtx({ callbackData: `app:${SID}` });
    const deps = aliveDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(startActiveDelegatedTaskMock).not.toHaveBeenCalled();
    expect(ctx.texts().some((t) => t.includes("托管前计划预览"))).toBe(true);
    expect(JSON.stringify(ctx.replies)).toContain(`apc:${SID}`);
  });

  it("ap_confirm_delegate starts the same supervisor delegation path", async () => {
    const ctx = fakeCtx({ callbackData: `apc:${SID}` });
    const deps = aliveDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(startActiveDelegatedTaskMock).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ session: SESSION }),
    );
    expect(ctx.texts().some((t) => t.includes("Autopilot delegate queued"))).toBe(true);
  });

  it("voicelang (vl:) sets the env var and refreshes the picker", async () => {
    const prev = process.env.TELEGRAM_WHISPER_LANGUAGE;
    const ctx = fakeCtx({ callbackData: "vl:en" });
    const deps = fakeDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(process.env.TELEGRAM_WHISPER_LANGUAGE).toBe("en");
    expect(ctx.answered.some((t) => typeof t === "string" && t.includes("en"))).toBe(true);
    expect(ctx.editedMarkups).toHaveLength(1);

    if (prev === undefined) delete process.env.TELEGRAM_WHISPER_LANGUAGE;
    else process.env.TELEGRAM_WHISPER_LANGUAGE = prev;
  });

  it("answers 'session gone' when the sid resolves to no alive session", async () => {
    const ctx = fakeCtx({ callbackData: `pk:${SID}` });
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.answered.some((t) => typeof t === "string" && t.includes("会话不存在"))).toBe(true);
  });

  it("switch (s:) switches the current project and confirms", async () => {
    const ctx = fakeCtx({ callbackData: `s:${SID}` });
    const setCurrent = vi.fn(async () => {});
    const deps = aliveDeps({ currentProject: { set: setCurrent } });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(setCurrent).toHaveBeenCalledWith("telegram:100", SESSION);
    expect(ctx.answered.some((t) => typeof t === "string" && t.includes("已切换"))).toBe(true);
    expect(ctx.texts().some((t) => t.includes("已切换"))).toBe(true);
  });

  it("remove (r:) tears down the project and confirms", async () => {
    const ctx = fakeCtx({ callbackData: `r:${SID}` });
    const killSession = vi.fn(async () => {});
    const deps = aliveDeps({
      bridge: { killSession },
      agent: { checkIfRunning: vi.fn(async () => false) },
    });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(killSession).toHaveBeenCalledWith(SESSION);
    expect(ctx.texts().some((t) => t.includes("已移除"))).toBe(true);
  });

  it("peek (pk:) renders the pane view", async () => {
    const ctx = fakeCtx({ callbackData: `pk:${SID}` });
    const deps = aliveDeps({
      bridge: { capturePaneColored: vi.fn(async () => "PANE") },
      output: { clean: vi.fn((s: string) => s) },
    });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.texts().some((t) => t.includes("PANE"))).toBe(true);
  });

  it("history (hi:) renders a history view (warns when no path mapping)", async () => {
    const ctx = fakeCtx({ callbackData: `hi:${SID}` });
    const deps = aliveDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
  });

  it("control action (a:status:<sid>) runs executeMessage and replies the result", async () => {
    const ctx = fakeCtx({ callbackData: `a:status:${SID}` });
    const deps = aliveDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.answered.some((t) => typeof t === "string" && t.includes("/status"))).toBe(true);
    expect(ctx.texts().some((t) => t.includes("运行中"))).toBe(true);
  });

  it("add (g:) recreates/switches a recent project (here: unknown sid → err)", async () => {
    const ctx = fakeCtx({ callbackData: `g:${SID}` });
    const deps = fakeDeps();

    await handleCallbackQuery(ctx, deps, replyTarget);

    // sid not in recents → noShortId error; the callback is still answered.
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.texts().some((t) => t.includes("未找到短 ID"))).toBe(true);
  });

  it("answers '出错了' when a handler throws", async () => {
    const ctx = fakeCtx({ callbackData: "la" });
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });

    await handleCallbackQuery(ctx, deps, replyTarget);

    // sendAliveList swallows its own error and replies the message; no throw to
    // the outer catch. Assert the error text surfaced to the user instead.
    expect(ctx.texts().some((t) => t.includes("boom"))).toBe(true);
  });

  describe("directory browser callbacks", () => {
    it("a browse navigation tap answers the callback (and re-renders in place)", async () => {
      const ctx = fakeCtx({ callbackData: "br:cd:0" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    it("browsecancel answers and forgets the navigation state", async () => {
      const ctx = fakeCtx({ callbackData: "br:x" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    it("browsenewfolder prompts for a name with force_reply", async () => {
      const nav = fakeCtx({ callbackData: "br:cd:0", chatId: 777 });
      const deps = fakeDeps();
      await handleCallbackQuery(nav, deps, replyTarget);
      const nf = fakeCtx({ callbackData: "br:nf", chatId: 777 });
      await handleCallbackQuery(nf, deps, replyTarget);
      expect(nf.reply).toHaveBeenCalled();
    });

    it("browseselect creates a project at the browsed dir", async () => {
      // First a nav tap to establish the scope's cwd (the single $HOME-ish root),
      // then select-here, which runs createProjectFromPath and replies the outcome.
      const nav = fakeCtx({ callbackData: "br:cd:0", chatId: 555 });
      const deps = fakeDeps();
      await handleCallbackQuery(nav, deps, replyTarget);
      const sel = fakeCtx({ callbackData: "br:sel", chatId: 555 });
      await handleCallbackQuery(sel, deps, replyTarget);
      // The root (/home/user) doesn't exist in the test env → a "not found" reply,
      // proving the select path resolved a cwd and ran the create flow.
      expect(sel.texts().length).toBeGreaterThan(0);
    });
  });

  describe("free-project label prompt", () => {
    it("newfree (nf) arms the label capture and prompts", async () => {
      const ctx = fakeCtx({ callbackData: "nf" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.texts().some((t) => t.includes("请输入独立会话名称"))).toBe(true);
    });

    it("newfreecancel (nfx) clears the capture, toasts, and drops the keyboard", async () => {
      const ctx = fakeCtx({ callbackData: "nfx" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answered.some((t) => t === "已取消")).toBe(true);
      expect(ctx.editedMarkups).toHaveLength(1);
    });
  });

  describe("queued-message cancel (qx)", () => {
    it("toasts 'cancelled' and drops the button when the item is still queued", async () => {
      const ctx = fakeCtx({ callbackData: `qx:${SID}:msg-1` });
      const deps = aliveDeps({ queue: { cancelQueued: vi.fn(() => true) } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(deps.queue.cancelQueued).toHaveBeenCalledWith(SESSION, "msg-1", expect.any(String));
      expect(
        ctx.answered.some((t) => typeof t === "string" && t.includes("已取消该排队消息")),
      ).toBe(true);
      expect(ctx.editedMarkups).toHaveLength(1);
    });

    it("falls to the outer catch (toastError) when sid resolution throws", async () => {
      const ctx = fakeCtx({ callbackData: `qx:${SID}:msg-1` });
      const deps = fakeDeps({
        bridge: {
          listProjectSessions: vi.fn(async () => {
            throw new Error("boom");
          }),
        },
      });

      await handleCallbackQuery(ctx, deps, replyTarget);

      // The throw propagates to handleCallbackQuery's top-level catch, which toasts
      // the generic error and posts nothing.
      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("出错"))).toBe(true);
      expect(ctx.texts()).toHaveLength(0);
    });

    it("toasts 'gone' when the queued item is no longer present", async () => {
      const ctx = fakeCtx({ callbackData: `qx:${SID}:msg-1` });
      const deps = aliveDeps({ queue: { cancelQueued: vi.fn(() => false) } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("已不在队列"))).toBe(
        true,
      );
    });

    it("toasts 'gone' when the sid resolves to no alive session", async () => {
      const ctx = fakeCtx({ callbackData: `qx:${SID}:msg-1` });
      const cancelQueued = vi.fn(() => false);
      const deps = fakeDeps({
        bridge: { listProjectSessions: vi.fn(async () => []) },
        queue: { cancelQueued },
      });

      await handleCallbackQuery(ctx, deps, replyTarget);

      // No alive session → cancelQueued is short-circuited, the item is "gone".
      expect(cancelQueued).not.toHaveBeenCalled();
      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("已不在队列"))).toBe(
        true,
      );
    });
  });

  describe("UI-language pick (ul)", () => {
    it("sets the UI language and refreshes the picker in place", async () => {
      // setUiLang mutates the live (process-wide) UI language, so reset it to the
      // default afterward — otherwise every later assertion reads English copy.
      const prev = process.env.TELEGRAM_UI_LANG;
      const ctx = fakeCtx({ callbackData: "ul:en" });

      try {
        await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

        expect(process.env.TELEGRAM_UI_LANG).toBe("en");
        // A toast confirming the pick + the picker refreshed in place. (Copy is now
        // English, so assert on the language code rather than localized text.)
        expect(ctx.answered.some((t) => typeof t === "string" && t.includes("English"))).toBe(true);
        expect(ctx.editedMarkups).toHaveLength(1);
      } finally {
        setUiLangBack(prev);
      }
    });
  });

  describe("resume (rs)", () => {
    it("errors when there is no current session", async () => {
      const ctx = fakeCtx({ callbackData: "rs:11111111-2222-3333-4444-555555555555" });
      const deps = fakeDeps({ currentProject: { get: vi.fn(async () => null) } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(ctx.answered.some((t) => t === "➕ 处理中…")).toBe(true);
      expect(ctx.texts().some((t) => t.includes("没有活跃会话"))).toBe(true);
    });

    it("exits + resumes the live session and confirms with the short id", async () => {
      const uuid = "11111111-2222-3333-4444-555555555555";
      const ctx = fakeCtx({ callbackData: `rs:${uuid}` });
      const sendExit = vi.fn(async () => {});
      const startWithResume = vi.fn(async () => {});
      const deps = fakeDeps({
        currentProject: { get: vi.fn(async () => SESSION) },
        bridge: { sendExit, listProjectSessions: vi.fn(async () => [SESSION]) },
        agent: { startWithResume },
      });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(deps.queue.clearSession).toHaveBeenCalledWith(SESSION);
      expect(sendExit).toHaveBeenCalledWith(SESSION);
      expect(startWithResume).toHaveBeenCalledWith(SESSION, uuid, undefined);
      expect(deps.configResolver.invalidate).toHaveBeenCalledWith(SESSION);
      expect(ctx.texts().some((t) => t.includes("已恢复会话") && t.includes("11111111"))).toBe(
        true,
      );
    });
  });

  describe("adopt orphan (as / ae / ac / aa)", () => {
    it("adoptshow (as) errors when the orphan is gone", async () => {
      findAdoptableOrphansMock.mockResolvedValueOnce([]);
      const ctx = fakeCtx({ callbackData: "as:4242" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      expect(ctx.texts().some((t) => t.includes("已不在可接管列表"))).toBe(true);
    });

    it("adoptshow (as) shows a confirm keyboard when the orphan is found", async () => {
      findAdoptableOrphansMock.mockResolvedValueOnce([
        { pid: 4242, agent: "claude", cwd: "/x", sessionId: "s", command: "claude" },
      ] as never);
      const ctx = fakeCtx({ callbackData: "as:4242" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      expect(ctx.replies.some((r) => r.extra.reply_markup !== undefined)).toBe(true);
    });

    it("adoptexec (ae) replies the error body when the adopt fails", async () => {
      adoptOrphanMock.mockResolvedValueOnce(null);
      const ctx = fakeCtx({ callbackData: "ae:4242" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      expect(ctx.answered.some((t) => t === "正在接管…")).toBe(true);
      expect(ctx.texts().some((t) => t.includes("已不在可接管列表"))).toBe(true);
    });

    it("adoptexec (ae) sets the current project and confirms on success", async () => {
      adoptOrphanMock.mockResolvedValueOnce({
        ok: true,
        sessionName: SESSION,
        resumed: false,
      } as never);
      const setCurrent = vi.fn(async () => {});
      const ctx = fakeCtx({ callbackData: "ae:4242" });
      const deps = fakeDeps({ currentProject: { set: setCurrent } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(setCurrent).toHaveBeenCalledWith("telegram:100", SESSION);
      expect(ctx.replies.length).toBeGreaterThan(0);
    });

    it("adoptexec free (af) passes the free target to takeover", async () => {
      adoptOrphanMock.mockResolvedValueOnce({
        ok: true,
        sessionName: SESSION,
        resumed: true,
      } as never);
      const ctx = fakeCtx({ callbackData: "af:4242" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      expect(adoptOrphanMock).toHaveBeenCalledWith(4242, expect.any(Object), { target: "free" });
    });

    it("adoptcancel (ac) just toasts", async () => {
      const ctx = fakeCtx({ callbackData: "ac" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answered.some((t) => t === "已取消接管")).toBe(true);
    });

    it("adoptattach (aa) replies the attach hint for an alive session", async () => {
      const ctx = fakeCtx({ callbackData: `aa:${SID}` });
      await handleCallbackQuery(ctx, aliveDeps(), replyTarget);
      expect(ctx.texts().some((t) => t.includes("tmux attach"))).toBe(true);
      expect(copyToClipboard).not.toHaveBeenCalled();
    });

    it("adoptattach (aa) toasts 'session gone' for an unknown sid", async () => {
      const ctx = fakeCtx({ callbackData: `aa:${SID}` });
      const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });
      await handleCallbackQuery(ctx, deps, replyTarget);
      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("会话不存在"))).toBe(
        true,
      );
    });
  });

  describe("recovery (rcv / rec / recx)", () => {
    it("recover (rec) reports the done summary", async () => {
      recoverProjectsMock.mockResolvedValueOnce({
        launched: [],
        shellOnly: [],
        alreadyAlive: [],
        skippedMissingDir: [],
        failed: [],
        busy: false,
      } as never);
      const ctx = fakeCtx({ callbackData: "rec" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      expect(ctx.answered.some((t) => t === "正在恢复…")).toBe(true);
      expect(ctx.texts().length).toBeGreaterThan(0);
    });

    it("recoverlist (rcv) renders the recovery preview", async () => {
      const ctx = fakeCtx({ callbackData: "rcv" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      // Empty roster in the fake → the "nothing to recover" preview.
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.texts().length).toBeGreaterThan(0);
    });

    it("recover (rec) reports the failed summary when a relaunch failed", async () => {
      recoverProjectsMock.mockResolvedValueOnce({
        launched: [],
        shellOnly: [],
        alreadyAlive: [],
        skippedMissingDir: [],
        failed: [{ sessionName: SESSION }],
        busy: false,
      } as never);
      const ctx = fakeCtx({ callbackData: "rec" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      // failed.length > 0 → the "err" tone arm of the done summary.
      expect(ctx.texts().length).toBeGreaterThan(0);
    });

    it("recover (rec) reports 'busy' when a recovery is already running", async () => {
      recoverProjectsMock.mockResolvedValueOnce({
        launched: [],
        shellOnly: [],
        alreadyAlive: [],
        skippedMissingDir: [],
        failed: [],
        busy: true,
      } as never);
      const ctx = fakeCtx({ callbackData: "rec" });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      expect(ctx.texts().some((t) => t.includes("已有一个恢复正在进行"))).toBe(true);
    });

    it("recovercancel (recx) just toasts", async () => {
      const ctx = fakeCtx({ callbackData: "recx" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answered.some((t) => t === "已取消恢复。")).toBe(true);
    });
  });

  describe("status install (si)", () => {
    it("delegates to sendStatusInstall with the parsed action", async () => {
      const ctx = fakeCtx({ callbackData: "si:wrap" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(sendStatusInstallMock).toHaveBeenCalledWith(ctx, "wrap", replyTarget);
    });
  });

  describe("recent inputs (ins / inp)", () => {
    it("inputslist (ins) warns when the session has no path mapping", async () => {
      const ctx = fakeCtx({ callbackData: `ins:${SID}` });
      await handleCallbackQuery(ctx, aliveDeps(), replyTarget);
      expect(ctx.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
    });

    it("inputredo (inp) hands back the cached prompt as an editable draft", async () => {
      const token = storeInputList(SESSION, ["fix the failing test"]);
      const ctx = fakeCtx({ callbackData: `inp:${token}:0` });

      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);

      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("草稿"))).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith("fix the failing test");
    });

    it("inputredo (inp) toasts 'expired' for an unknown token", async () => {
      const ctx = fakeCtx({ callbackData: "inp:nope:0" });
      await handleCallbackQuery(ctx, fakeDeps(), replyTarget);
      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("列表已过期"))).toBe(
        true,
      );
    });
  });

  describe("start / restart pickers (sp / rp) and start/restart dispositions", () => {
    it("startpick (sp) with an out-of-range index just answers (no start)", async () => {
      const ctx = fakeCtx({ callbackData: `sp:9:${SID}` });
      const start = vi.fn(async () => {});
      const deps = aliveDeps({ agent: { start, checkIfRunning: vi.fn(async () => false) } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(start).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    it("startpick (sp) starts the picked flavor and confirms", async () => {
      const ctx = fakeCtx({ callbackData: `sp:0:${SID}` });
      const deps = aliveDeps({ agent: { checkIfRunning: vi.fn(async () => false) } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("start"))).toBe(true);
      expect(ctx.texts().some((t) => t.includes("已用「claude」启动"))).toBe(true);
    });

    it("startpick (sp) reports already-running when the agent is up", async () => {
      const ctx = fakeCtx({ callbackData: `sp:0:${SID}` });
      const deps = aliveDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(ctx.texts().some((t) => t.includes("已在运行中"))).toBe(true);
    });

    it("restartpick (rp) restarts into the picked flavor and confirms", async () => {
      const ctx = fakeCtx({ callbackData: `rp:0:${SID}` });
      const gracefulRestartWithContinue = vi.fn(async () => {});
      const deps = aliveDeps({ agent: { gracefulRestartWithContinue } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(gracefulRestartWithContinue).toHaveBeenCalled();
      expect(ctx.answered.some((t) => typeof t === "string" && t.includes("restart"))).toBe(true);
      expect(ctx.texts().some((t) => t.includes("已用「claude」启动"))).toBe(true);
    });

    it("start action rejects with 'already running' when the agent is up", async () => {
      const ctx = fakeCtx({ callbackData: `a:start:${SID}` });
      const deps = aliveDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(ctx.texts().some((t) => t.includes("已在运行中"))).toBe(true);
    });

    it("start action shows the flavor picker when multiple start commands exist", async () => {
      const ctx = fakeCtx({ callbackData: `a:start:${SID}` });
      const deps = aliveDeps({
        agent: { checkIfRunning: vi.fn(async () => false) },
        config: {
          startCommands: [
            { label: "claude", command: "bash" },
            { label: "codex", command: "bash", agent: "codex" },
          ],
        },
      });

      await handleCallbackQuery(ctx, deps, replyTarget);

      expect(ctx.texts().some((t) => t.includes("配置了多个启动命令"))).toBe(true);
      expect(ctx.replies.some((r) => r.extra.reply_markup !== undefined)).toBe(true);
    });
  });
});

/** Restore TELEGRAM_UI_LANG (and reset the live UI lang) after the ul: test. */
function setUiLangBack(prev: string | undefined): void {
  if (prev === undefined) delete process.env.TELEGRAM_UI_LANG;
  else process.env.TELEGRAM_UI_LANG = prev;
}
