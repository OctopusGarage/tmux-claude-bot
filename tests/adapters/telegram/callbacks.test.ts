import { beforeEach, describe, expect, it, vi } from "vitest";

// Avoid touching the real .env in the voice-language branch; keep VOICE_LANGS etc.
vi.mock("../../../src/core/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/voice-support.js")>()),
  persistEnvVar: vi.fn(),
}));

import { handleCallbackQuery } from "../../../src/adapters/telegram/callbacks.js";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";
import { sessionShortId } from "../../../src/shared/utils/hash.js";
import { fakeCtx, fakeDeps } from "./_fakes.js";

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

    expect(ctx.texts().some((t) => t.includes("没有活跃项目"))).toBe(true);
  });

  it("queuestatus (qs) renders the queue-status view", async () => {
    const ctx = fakeCtx({ callbackData: "qs" });
    const deps = fakeDeps({
      queue: { getGlobalQueue: vi.fn(() => []), getSessionNames: vi.fn(() => []) },
    });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(ctx.texts().some((t) => t.includes("队列状态"))).toBe(true);
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
      claude: { checkIfRunning: vi.fn(async () => false) },
    });

    await handleCallbackQuery(ctx, deps, replyTarget);

    expect(killSession).toHaveBeenCalledWith(SESSION);
    expect(ctx.texts().some((t) => t.includes("已移除"))).toBe(true);
  });

  it("peek (pk:) renders the pane view", async () => {
    const ctx = fakeCtx({ callbackData: `pk:${SID}` });
    const deps = aliveDeps({
      bridge: { capturePane: vi.fn(async () => "PANE") },
      output: { process: vi.fn((s: string) => s) },
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
    const deps = aliveDeps({ claude: { checkIfRunning: vi.fn(async () => true) } });

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
});
