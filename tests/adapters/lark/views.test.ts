import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReplyTarget } from "../../../src/adapters/lark/reply-target.js";
import {
  addProject,
  addRecentBySid,
  handleWsCommand,
  sendAliveList,
  sendCurrentProject,
  sendHistory,
  sendLangPicker,
  sendPeek,
  sendQueueStatus,
  sendRecentList,
  sendVoiceLangPicker,
} from "../../../src/adapters/lark/views.js";
import { projectPathToHistoryDir } from "../../../src/core/history.js";
import type { QueuedMessage } from "../../../src/core/queue.js";
import { setPathForSession } from "../../../src/core/sessionPathMap.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

const qmsg = (text: string): QueuedMessage =>
  ({ id: "x", text, chatId: "c", action: "text", resolve() {}, reject() {} }) as QueuedMessage;

describe("language pickers go out as managed cards", () => {
  it("sendVoiceLangPicker sends the picker via cardkit so clicks can update it in place", async () => {
    const channel = fakeChannel();
    await sendVoiceLangPicker(channel, "oc_chat");
    expect(channel.cardkitCreates.some((c) => c.data.data.includes("语音识别语言"))).toBe(true);
    expect(channel.imCreates).toHaveLength(1);
  });

  it("sendLangPicker sends the picker via cardkit so clicks can update it in place", async () => {
    const channel = fakeChannel();
    await sendLangPicker(channel, "oc_chat");
    expect(channel.cardkitCreates).toHaveLength(1);
    expect(channel.imCreates).toHaveLength(1);
  });
});

describe("sendQueueStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the in-flight msg under ▶ and only waiting items under 排队中", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      queue: {
        getGlobalQueue: vi.fn(() => [qmsg("waiting-1"), qmsg("waiting-2")]),
        isGlobalProcessing: vi.fn(() => true),
        getCurrentGlobalMessage: vi.fn(() => qmsg("in-flight")),
        getSessionNames: vi.fn(() => []),
      },
    });

    await sendQueueStatus(channel, deps, "chat-1");

    const text = channel.texts().join("\n");
    // The in-flight message is rendered under ▶, not counted in 排队中.
    expect(text).toContain("排队中： 2");
    expect(text).toContain("▶ in-flight");
    expect(text).not.toContain("排队中： 3");
  });

  it("renders per-session queues with the project label", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      queue: {
        getGlobalQueue: vi.fn(() => []),
        getSessionNames: vi.fn(() => ["tmux_proj_zeta"]),
        getSessionQueue: vi.fn(() => [qmsg("s-waiting")]),
        isSessionProcessing: vi.fn(() => true),
        getCurrentSessionMessage: vi.fn(() => qmsg("s-inflight")),
        getLastProcessedAt: vi.fn(() => undefined),
      },
    });

    await sendQueueStatus(channel, deps, "chat-1");

    const text = channel.texts().join("\n");
    expect(text).toContain("▶ s-inflight");
    expect(text).toContain("1. s-waiting");
  });

  it("shows last-processed time when getLastProcessedAt returns a timestamp", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      queue: {
        getGlobalQueue: vi.fn(() => []),
        getSessionNames: vi.fn(() => ["tmux_proj_eta"]),
        getSessionQueue: vi.fn(() => []),
        isSessionProcessing: vi.fn(() => false),
        getCurrentSessionMessage: vi.fn(() => undefined),
        getLastProcessedAt: vi.fn(() => Date.now() - 5000),
      },
    });
    await sendQueueStatus(channel, deps, "chat-1");
    const text = channel.texts().join("\n");
    expect(text).toContain("上次完成");
  });
});

describe("sendAliveList / sendRecentList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sendAliveList sends a project list card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => []) },
    });

    await sendAliveList(channel, deps, "chat-1");

    expect(channel.cards()).toHaveLength(1);
  });

  it("sendRecentList sends a recent list card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();

    await sendRecentList(channel, deps, "chat-1");

    expect(channel.cards()).toHaveLength(1);
  });
});

describe("sendPeek / sendHistory record reply targets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sendPeek sends a view card and records the reply target", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-peek" });

    await sendPeek(channel, deps, "chat-1");

    expect(deps.bridge.capturePane).toHaveBeenCalledWith("proj-peek");
    expect(channel.cards()).toHaveLength(1);
    // sendCard returns messageId "m1"; reply target must point back to the session.
    expect(resolveReplyTarget("m1")).toBe("proj-peek");
  });

  it("sendPeek with no current project replies plain text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });

    await sendPeek(channel, deps, "chat-1");

    expect(channel.texts()).toContain("无当前项目");
    expect(channel.cards()).toHaveLength(0);
  });

  it("sendHistory without a path mapping replies the hint", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-no-path" });

    await sendHistory(channel, deps, "chat-1", 0);

    expect(channel.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
  });

  it("sendHistory with a path mapping but no transcripts replies 'no history'", async () => {
    const session = "proj-with-path";
    setPathForSession(session, "/tmp/no-such-history-dir-xyz");
    const channel = fakeChannel();
    const deps = fakeDeps({ session });

    await sendHistory(channel, deps, "chat-1", 0);

    expect(channel.texts().some((t) => t.includes("没有找到对话历史"))).toBe(true);
  });

  it("sendPeek uses the emptyPane placeholder when output.process returns empty string", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ output: { process: vi.fn(() => "") } });

    await sendPeek(channel, deps, "chat-1");

    // The card should contain the emptyPane placeholder, not be skipped entirely.
    expect(channel.cards()).toHaveLength(1);
  });

  it("sendHistory with a valid index sends a history card", async () => {
    const session = "proj-hist-valid";
    const projectPath = "/proj/hist/valid";
    const configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-hist-v-"));
    try {
      const histDir = projectPathToHistoryDir(projectPath, configRoot);
      fs.mkdirSync(histDir, { recursive: true });
      const mkLine = (type: string, content: string) =>
        JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
      fs.writeFileSync(
        nodePath.join(histDir, "a.jsonl"),
        `${[mkLine("user", "test question here"), mkLine("assistant", "test answer here")].join("\n")}\n`,
        "utf-8",
      );

      setPathForSession(session, projectPath);
      const channel = fakeChannel();
      const deps = fakeDeps({
        session,
        configResolver: { resolveConfigRoot: vi.fn(async () => configRoot) },
      });

      await sendHistory(channel, deps, "chat-1", 0);

      expect(channel.cards()).toHaveLength(1);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it("sendHistory with an out-of-bounds index replies onlyNRounds", async () => {
    const session = "proj-hist-oob";
    const projectPath = "/proj/hist/oob";
    const configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-hist-oob-"));
    try {
      const histDir = projectPathToHistoryDir(projectPath, configRoot);
      fs.mkdirSync(histDir, { recursive: true });
      const mkLine = (type: string, content: string) =>
        JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
      fs.writeFileSync(
        nodePath.join(histDir, "a.jsonl"),
        `${[mkLine("user", "one question"), mkLine("assistant", "one answer")].join("\n")}\n`,
        "utf-8",
      );

      setPathForSession(session, projectPath);
      const channel = fakeChannel();
      const deps = fakeDeps({
        session,
        configResolver: { resolveConfigRoot: vi.fn(async () => configRoot) },
      });

      await sendHistory(channel, deps, "chat-1", 99);

      expect(channel.texts().some((t) => t.includes("只有"))).toBe(true);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
});

describe("alive/recent error branches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sendAliveList reports the error when listing fails", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => {
          throw new Error("tmux down");
        }),
      },
    });
    await sendAliveList(channel, deps, "chat-1");
    expect(channel.texts().some((t) => t.includes("错误：tmux down"))).toBe(true);
  });

  it("sendRecentList reports the error when listing fails", async () => {
    const channel = fakeChannel();
    // mock recentProjectButtons to throw by making bridge.hasSession throw
    const deps = fakeDeps({
      bridge: {
        hasSession: vi.fn(async () => {
          throw new Error("recent fail");
        }),
      },
    });
    // populate recents so the path hits bridge.hasSession
    const { appendRecentProject } = await import("../../../src/core/recentProjects.js");
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-rl-err-"));
    await appendRecentProject(tmpDir, "tmux_proj_");
    await sendRecentList(channel, deps, "chat-1");
    expect(channel.texts().some((t) => t.includes("错误：recent fail"))).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("addRecentBySid", () => {
  let allowedRoot: string;
  beforeEach(() => {
    vi.clearAllMocks();
    allowedRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-rsid-"));
  });
  afterEach(() => fs.rmSync(allowedRoot, { recursive: true, force: true }));

  it("replies 'not found' when the sid matches no recent project", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    await addRecentBySid(channel, deps, "chat-1", "no-such-sid");
    expect(channel.texts().some((t) => t.includes("未找到短 id"))).toBe(true);
  });

  it("switches to the session when it already exists", async () => {
    const channel = fakeChannel();
    const prefix = "tmux_proj_";
    const sessionName = `tmux_proj_${allowedRoot.replace(/\//g, "-")}`;
    const deps = fakeDeps({
      config: { cdAllowedDirs: [allowedRoot], projectSessionPrefix: prefix, sessionWarmupMs: 0 },
      bridge: { hasSession: vi.fn(async () => true) },
    });
    // populate recents so addRecentBySid can find the sid
    const { appendRecentProject } = await import("../../../src/core/recentProjects.js");
    await appendRecentProject(allowedRoot, prefix);
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const sid = sessionShortId(sessionName);
    await addRecentBySid(channel, deps, "chat-1", sid);
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark:chat-1", sessionName);
    expect(channel.texts().some((t) => t.includes("已切换"))).toBe(true);
  });

  it("rejects a path outside cdAllowedDirs when session does not exist", async () => {
    const channel = fakeChannel();
    const prefix = "tmux_proj_";
    const allowedOther = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-other-"));
    const deps = fakeDeps({
      config: { cdAllowedDirs: [allowedOther], projectSessionPrefix: prefix, sessionWarmupMs: 0 },
      bridge: { hasSession: vi.fn(async () => false) },
    });
    const { appendRecentProject } = await import("../../../src/core/recentProjects.js");
    await appendRecentProject(allowedRoot, prefix);
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const sessionName = `tmux_proj_${allowedRoot.replace(/\//g, "-")}`;
    const sid = sessionShortId(sessionName);
    await addRecentBySid(channel, deps, "chat-1", sid);
    expect(channel.texts().some((t) => t.includes("路径不在允许范围"))).toBe(true);
    fs.rmSync(allowedOther, { recursive: true, force: true });
  });
});

describe("sendCurrentProject", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the current project", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-cur" });

    await sendCurrentProject(channel, deps, "chat-1");

    expect(channel.texts().some((t) => t.includes("当前项目"))).toBe(true);
  });

  it("reports none when unset", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });

    await sendCurrentProject(channel, deps, "chat-1");

    expect(channel.texts()).toContain("无当前项目");
  });
});

describe("addProject path allow-listing", () => {
  let allowedRoot: string;
  let disallowedRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    allowedRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-allow-"));
    disallowedRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-deny-"));
  });

  afterAll(() => {
    // best-effort cleanup handled per-test dirs; nothing global to clean.
  });

  it("rejects a directory outside cdAllowedDirs", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: { cdAllowedDirs: [allowedRoot] } });

    await addProject(channel, deps, "chat-1", disallowedRoot);

    expect(channel.texts().some((t) => t.includes("路径不在允许范围内"))).toBe(true);
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
  });

  it("rejects a non-existent directory", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: { cdAllowedDirs: [allowedRoot] } });

    await addProject(channel, deps, "chat-1", nodePath.join(allowedRoot, "does-not-exist"));

    expect(channel.texts().some((t) => t.includes("目录不存在"))).toBe(true);
  });

  it("creates an allowed project (new session)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      config: {
        cdAllowedDirs: [allowedRoot],
        projectSessionPrefix: "tmux_proj_",
        sessionWarmupMs: 0,
      },
      bridge: { hasSession: vi.fn(async () => false) },
    });

    await addProject(channel, deps, "chat-1", allowedRoot);

    expect(deps.bridge.createSession).toHaveBeenCalled();
    expect(deps.currentProject.set).toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("项目已创建"))).toBe(true);
  });

  it("reports the error when createSession throws", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      config: {
        cdAllowedDirs: [allowedRoot],
        projectSessionPrefix: "tmux_proj_",
        sessionWarmupMs: 0,
      },
      bridge: {
        hasSession: vi.fn(async () => false),
        createSession: vi.fn(async () => {
          throw new Error("tmux create failed");
        }),
      },
    });
    await addProject(channel, deps, "chat-1", allowedRoot);
    expect(channel.texts().some((t) => t.includes("错误：tmux create failed"))).toBe(true);
  });

  it("switches to an allowed project that already has a session", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      config: {
        cdAllowedDirs: [allowedRoot],
        projectSessionPrefix: "tmux_proj_",
        sessionWarmupMs: 0,
      },
      bridge: { hasSession: vi.fn(async () => true) },
    });

    await addProject(channel, deps, "chat-1", allowedRoot);

    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    expect(deps.currentProject.set).toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("已存在 · 已切换"))).toBe(true);
  });
});

// ── handleWsCommand ────────────────────────────────────────────────────────────

describe("handleWsCommand", () => {
  let wsStateDir: string;
  let origTCB: string | undefined;

  beforeEach(() => {
    wsStateDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-ws-"));
    origTCB = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = wsStateDir;
  });

  afterEach(() => {
    fs.rmSync(wsStateDir, { recursive: true, force: true });
    if (origTCB === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = origTCB;
  });

  it("list → empty message when no workspaces saved", async () => {
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "list");
    expect(channel.texts().some((t) => t.includes("暂无"))).toBe(true);
  });

  it("save → stores current project under name", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-1" });
    await handleWsCommand(channel, deps, "chat-1", "save my-ws");
    expect(channel.texts().some((t) => t.includes("已保存工作区「my-ws」"))).toBe(true);
  });

  it("save → no current project → error", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });
    await handleWsCommand(channel, deps, "chat-1", "save my-ws");
    expect(channel.texts().some((t) => t.includes("无当前项目"))).toBe(true);
  });

  it("save → invalid name → error", async () => {
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "save inv@lid!");
    expect(channel.texts().some((t) => t.includes("仅允许"))).toBe(true);
  });

  it("use → switches to the saved session when alive", async () => {
    const { saveWorkspace } = await import("../../../src/core/workspaces.js");
    saveWorkspace("my-ws", "proj-1");
    const channel = fakeChannel();
    const deps = fakeDeps({ bridge: { hasSession: vi.fn(async () => true) } });
    await handleWsCommand(channel, deps, "chat-1", "use my-ws");
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark:chat-1", "proj-1");
    expect(channel.texts().some((t) => t.includes("已切换到工作区「my-ws」"))).toBe(true);
  });

  it("use → session gone → error", async () => {
    const { saveWorkspace } = await import("../../../src/core/workspaces.js");
    saveWorkspace("gone-ws", "dead-session");
    const channel = fakeChannel();
    const deps = fakeDeps({ bridge: { hasSession: vi.fn(async () => false) } });
    await handleWsCommand(channel, deps, "chat-1", "use gone-ws");
    expect(channel.texts().some((t) => t.includes("会话已不存在"))).toBe(true);
  });

  it("use → workspace not found → error", async () => {
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "use no-such-ws");
    expect(channel.texts().some((t) => t.includes("不存在"))).toBe(true);
  });

  it("remove → deletes saved workspace", async () => {
    const { saveWorkspace } = await import("../../../src/core/workspaces.js");
    saveWorkspace("del-ws", "proj-x");
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "remove del-ws");
    expect(channel.texts().some((t) => t.includes("已删除工作区「del-ws」"))).toBe(true);
  });

  it("remove → not found → error", async () => {
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "remove ghost");
    expect(channel.texts().some((t) => t.includes("不存在"))).toBe(true);
  });

  it("unknown subcommand → usage hint", async () => {
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "bogus");
    expect(channel.texts().some((t) => t.includes("用法"))).toBe(true);
  });

  it("no arg → usage hint", async () => {
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", undefined);
    expect(channel.texts().some((t) => t.includes("用法"))).toBe(true);
  });

  it("list → shows saved workspaces", async () => {
    const { saveWorkspace } = await import("../../../src/core/workspaces.js");
    saveWorkspace("proj-a", "sess-a");
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "list");
    expect(channel.texts().some((t) => t.includes("proj-a"))).toBe(true);
  });
});
