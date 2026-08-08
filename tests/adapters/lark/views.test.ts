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
  sendBrowse,
  sendCurrentProject,
  sendDashboard,
  sendDoctor,
  sendFreeGroupPicker,
  sendGroupBindPicker,
  sendGroupMenu,
  sendHistory,
  sendInputs,
  sendLangPicker,
  sendLogs,
  sendOrphanList,
  sendPeek,
  sendPromptTranslatePicker,
  sendQueueStatus,
  sendRecentList,
  sendRecoverPreview,
  sendSessionsList,
  sendVoiceLangPicker,
  startOrPickAfterCreate,
} from "../../../src/adapters/lark/views.js";
import { projectPathToHistoryDir } from "../../../src/core/agents/claude/claude-history.js";
import type { QueuedMessage } from "../../../src/core/command/queue.js";
import { bindGroup, unbindGroup } from "../../../src/core/projects/group-bindings.js";
import { setPathForSession } from "../../../src/core/projects/sessionPathMap.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

vi.mock("../../../src/core/read/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/voice-support.js")>()),
  checkVoiceSupport: vi.fn(() => ({ ready: false, reason: "not-installed" })),
  isVoicePlatformSupported: vi.fn(() => true),
}));

const qmsg = (text: string): QueuedMessage =>
  ({ id: "x", text, chatId: "c", action: "text", resolve() {}, reject() {} }) as QueuedMessage;

describe("sendGroupMenu — project-group overview (feature C)", () => {
  const BOUND = "oc_alpha_grp";
  afterEach(() => unbindGroup(BOUND));

  it("from a private chat, lists existing groups (label + path) plus the create picker", async () => {
    bindGroup(BOUND, {
      workspacePath: "/proj/alpha",
      sessionName: "tmux_proj_alpha",
      label: "alpha",
    });
    const channel = fakeChannel();
    await sendGroupMenu(channel, fakeDeps(), "ou_dm_unbound");
    const cards = JSON.stringify(channel.cards());
    expect(cards).toContain("alpha"); // existing group is listed...
    expect(cards).toContain("/proj/alpha"); // ...with its workspace path
  });

  it("from a private chat, shows existing group runtime status when the session is live", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-group-status-"));
    const pathA = nodePath.join(root, "alpha");
    fs.mkdirSync(pathA);
    const sessionName = "tmux_proj_alpha_status";
    setPathForSession(sessionName, pathA);
    bindGroup(BOUND, {
      workspacePath: pathA,
      sessionName,
      label: "alpha",
    });
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [sessionName]) },
      configResolver: { detectAgentKind: vi.fn(async () => "codex" as const) },
    });

    const channel = fakeChannel();
    await sendGroupMenu(channel, deps, "ou_dm_unbound");

    const cards = JSON.stringify(channel.cards());
    expect(cards).toContain("会话：运行中");
    expect(cards).toContain("Agent：Codex");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("from a private chat, builds the group overview from one project picker read", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-group-one-read-"));
    const pathA = nodePath.join(root, "alpha");
    fs.mkdirSync(pathA);
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => []) },
    });
    await appendRecentProject(pathA, deps.config.projectSessionPrefix);

    const channel = fakeChannel();
    await sendGroupMenu(channel, deps, "ou_dm_unbound");

    expect(deps.bridge.listProjectSessions).toHaveBeenCalledTimes(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("from inside a bound group, still shows the bound-group management card", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-bound-card-"));
    const pathA = nodePath.join(root, "alpha");
    fs.mkdirSync(pathA);
    const sessionName = "tmux_proj_bound_alpha";
    setPathForSession(sessionName, pathA);
    bindGroup(BOUND, {
      workspacePath: pathA,
      sessionName,
      label: "alpha",
    });
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [sessionName]) },
      configResolver: { detectAgentKind: vi.fn(async () => "codex" as const) },
    });
    const channel = fakeChannel();
    await sendGroupMenu(channel, deps, BOUND); // the bound chat itself
    const cards = JSON.stringify(channel.cards());
    expect(cards).toContain("本群已绑定");
    expect(cards).toContain(pathA);
    expect(cards).toContain("会话：运行中");
    expect(cards).toContain("Agent：Codex");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("language pickers go out as regular cards", () => {
  it("sendVoiceLangPicker sends the voice-install card when voice is unavailable", async () => {
    const channel = fakeChannel();
    await sendVoiceLangPicker(channel, "oc_chat");
    expect(JSON.stringify(channel.cards())).toContain("voiceinstall");
  });

  it("sendPromptTranslatePicker sends the prompt-translation picker card", async () => {
    const channel = fakeChannel();
    await sendPromptTranslatePicker(channel, "oc_chat");
    expect(JSON.stringify(channel.cards())).toContain("翻译模式");
  });

  it("sendLangPicker sends the UI-language picker card", async () => {
    const channel = fakeChannel();
    await sendLangPicker(channel, "oc_chat");
    expect(channel.cards()).toHaveLength(1);
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
    // The in-flight message is rendered under the active marker, not counted as queued.
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

  it("sendAliveList keeps project-group status visible on Lark", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-alive-group-"));
    const session = "tmux_proj_lark_alive_group";
    setPathForSession(session, dir);
    bindGroup("oc_lark_alive_group", {
      workspacePath: dir,
      sessionName: session,
      label: "lark-project-group",
    });
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      configResolver: { detectAgentKind: vi.fn(async () => "claude" as const) },
    });

    try {
      await sendAliveList(channel, deps, "chat-1");

      const card = JSON.stringify(channel.cards());
      expect(card).toContain("群：lark-project-group");
      expect(card).toContain("类型：常规会话");
    } finally {
      unbindGroup("oc_lark_alive_group");
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

    expect(deps.bridge.capturePaneColored).toHaveBeenCalledWith("proj-peek", expect.any(Number));
    expect(channel.cards()).toHaveLength(1);
    // sendCard returns messageId "m1"; reply target must point back to the session.
    expect(resolveReplyTarget("m1")).toBe("proj-peek");
  });

  it("sendPeek with no current project replies plain text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });

    await sendPeek(channel, deps, "chat-1");

    expect(channel.texts()).toContain("无当前会话");
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
    // mock recentProjectButtons to throw by making the session listing throw
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => {
          throw new Error("recent fail");
        }),
      },
    });
    // populate recents so the path reaches the session listing
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
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
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
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
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
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

    expect(channel.texts().some((t) => t.includes("当前会话"))).toBe(true);
  });

  it("reports none when unset", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });

    await sendCurrentProject(channel, deps, "chat-1");

    expect(channel.texts()).toContain("无当前会话");
  });

  it("also shows the mapped workspace directory", async () => {
    setPathForSession("proj-cur", "/Users/me/work/proj-cur");
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-cur" });

    await sendCurrentProject(channel, deps, "chat-1");

    expect(channel.texts().some((t) => t.includes("/Users/me/work/proj-cur"))).toBe(true);
  });

  it("shows whether the current project is free and which agent it runs", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      session: "tmux_proj_free_2",
      configResolver: { detectAgentKind: vi.fn(async () => "codex" as const) },
    });

    await sendCurrentProject(channel, deps, "chat-1");

    const text = channel.texts().join("\n");
    expect(text).toContain("类型：独立会话");
    expect(text).toContain("Agent：Codex");
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

  it("rejects a path that exists but is a file, not a directory", async () => {
    const channel = fakeChannel();
    const filePath = nodePath.join(allowedRoot, "a-file.txt");
    fs.writeFileSync(filePath, "x", "utf-8");
    const deps = fakeDeps({ config: { cdAllowedDirs: [allowedRoot] } });

    await addProject(channel, deps, "chat-1", filePath);

    expect(channel.texts().some((t) => t.includes("不是目录"))).toBe(true);
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
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
    expect(channel.texts().some((t) => t.includes("无当前会话"))).toBe(true);
  });

  it("save → invalid name → error", async () => {
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "save inv@lid!");
    expect(channel.texts().some((t) => t.includes("仅允许"))).toBe(true);
  });

  it("use → switches to the saved session when alive", async () => {
    const { saveWorkspace } = await import("../../../src/core/projects/workspaces.js");
    saveWorkspace("my-ws", "proj-1");
    const channel = fakeChannel();
    const deps = fakeDeps({ bridge: { hasSession: vi.fn(async () => true) } });
    await handleWsCommand(channel, deps, "chat-1", "use my-ws");
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark:chat-1", "proj-1");
    expect(channel.texts().some((t) => t.includes("已切换到工作区「my-ws」"))).toBe(true);
  });

  it("use → session gone → error", async () => {
    const { saveWorkspace } = await import("../../../src/core/projects/workspaces.js");
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
    const { saveWorkspace } = await import("../../../src/core/projects/workspaces.js");
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
    const { saveWorkspace } = await import("../../../src/core/projects/workspaces.js");
    saveWorkspace("proj-a", "sess-a");
    const channel = fakeChannel();
    await handleWsCommand(channel, fakeDeps(), "chat-1", "list");
    expect(channel.texts().some((t) => t.includes("proj-a"))).toBe(true);
  });
});

describe("sendGroupMenu", () => {
  it("omits projects that already have a group from the new-group picker", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-gm-"));
    const pathA = nodePath.join(root, "alpha");
    const pathB = nodePath.join(root, "beta");
    fs.mkdirSync(pathA);
    fs.mkdirSync(pathB);
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
    const { sessionNameFromPath } = await import("../../../src/core/projects/sessionPathMap.js");
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const { bindGroup } = await import("../../../src/core/projects/group-bindings.js");

    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });
    const prefix = deps.config.projectSessionPrefix;
    await appendRecentProject(pathA, prefix);
    await appendRecentProject(pathB, prefix);
    const sidA = sessionShortId(sessionNameFromPath(pathA, prefix));
    const sidB = sessionShortId(sessionNameFromPath(pathB, prefix));
    // alpha already has a group; beta does not.
    bindGroup("oc_alpha", {
      workspacePath: pathA,
      sessionName: sessionNameFromPath(pathA, prefix),
      label: "alpha",
    });

    const channel = fakeChannel();
    await sendGroupMenu(channel, deps, "oc_fresh"); // an unbound chat → the picker

    const card = JSON.stringify(channel.cards());
    expect(card).toContain(sidB); // beta is still offered
    expect(card).not.toContain(sidA); // alpha already has a group → hidden
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("omits live independent sessions whose workspace path already has a group", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-gm-free-"));
    const pathA = nodePath.join(root, "alpha");
    const pathB = nodePath.join(root, "beta");
    fs.mkdirSync(pathA);
    fs.mkdirSync(pathB);
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
    const { sessionNameFromPath } = await import("../../../src/core/projects/sessionPathMap.js");
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");

    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => ["tmux_proj_free_9"]) },
    });
    const prefix = deps.config.projectSessionPrefix;
    await appendRecentProject(pathA, prefix);
    await appendRecentProject(pathB, prefix);
    setPathForSession("tmux_proj_free_9", pathA);
    const freeSid = sessionShortId("tmux_proj_free_9");
    const sidB = sessionShortId(sessionNameFromPath(pathB, prefix));
    bindGroup("oc_alpha", {
      workspacePath: pathA,
      sessionName: sessionNameFromPath(pathA, prefix),
      label: "alpha",
    });

    const channel = fakeChannel();
    await sendGroupMenu(channel, deps, "oc_fresh");

    const card = JSON.stringify(channel.cards());
    expect(card).toContain(sidB);
    expect(card).not.toContain(freeSid);
    unbindGroup("oc_alpha");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("omits live independent sessions from the regular project-group picker", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-gm-free-only-"));
    const regularPath = nodePath.join(root, "regular");
    const freePath = nodePath.join(root, "free");
    fs.mkdirSync(regularPath);
    fs.mkdirSync(freePath);
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
    const { sessionNameFromPath } = await import("../../../src/core/projects/sessionPathMap.js");
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const { setFreeProject } = await import("../../../src/core/projects/free-projects.js");

    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => ["tmux_proj_free_7"]) },
    });
    const prefix = deps.config.projectSessionPrefix;
    await appendRecentProject(regularPath, prefix);
    setFreeProject(7, { label: "free-live" });
    setPathForSession("tmux_proj_free_7", freePath);
    const regularSid = sessionShortId(sessionNameFromPath(regularPath, prefix));
    const freeSid = sessionShortId("tmux_proj_free_7");

    const channel = fakeChannel();
    await sendGroupMenu(channel, deps, "oc_fresh");

    const card = JSON.stringify(channel.cards());
    expect(card).toContain(regularSid);
    expect(card).not.toContain(freeSid);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("sendOrphanList", () => {
  it("replies the empty-text hint when no adoptable processes are found", async () => {
    const channel = fakeChannel();
    // In the test host no unmanaged claude/codex process is expected; assert
    // the path lands on one of the two valid branches and observably replied.
    await sendOrphanList(channel, "chat-1");
    const repliedEmpty = channel.texts().includes("没有发现可接管的进程");
    const repliedCard = channel.cards().length === 1;
    expect(repliedEmpty || repliedCard).toBe(true);
  });
});

describe("sendRecoverPreview", () => {
  it("replies the empty hint when nothing is tracked as running", async () => {
    const channel = fakeChannel();
    // No running sessions are recorded in a fresh test process → plan is empty.
    await sendRecoverPreview(channel, fakeDeps(), "chat-1");
    expect(channel.texts()).toContain("没有需要恢复的项目。");
    expect(channel.cards()).toHaveLength(0);
  });

  it("reports the error when planning throws", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: {
        isPaneAlive: vi.fn(async () => {
          throw new Error("recover boom");
        }),
      },
    });
    // Force a tracked running session so classifySession runs and throws.
    const { markSessionRunning } = await import("../../../src/core/agents/runningSessions.js");
    const session = "tmux_proj_recover_err";
    setPathForSession(session, "/tmp");
    markSessionRunning(session);
    try {
      await sendRecoverPreview(channel, deps, "chat-1");
      expect(channel.texts().some((t) => t.includes("recover boom"))).toBe(true);
    } finally {
      const { markSessionStopped } = await import("../../../src/core/agents/runningSessions.js");
      markSessionStopped(session);
    }
  });
});

describe("sendDoctor / sendDashboard", () => {
  it("sendDoctor sends the redacted health report as text", async () => {
    const channel = fakeChannel();
    await sendDoctor(channel, "chat-1");
    expect(channel.texts()).toHaveLength(1);
    expect(channel.cards()).toHaveLength(0);
  });

  it("sendDashboard sends the dashboard as a view card", async () => {
    const channel = fakeChannel();
    await sendDashboard(channel, fakeDeps(), "chat-1");
    expect(channel.cards()).toHaveLength(1);
    expect(JSON.stringify(channel.cards())).toContain("📊 仪表盘");
  });
});

describe("sendLogs", () => {
  let origLogDir: string | undefined;
  let logDir: string;

  beforeEach(() => {
    origLogDir = process.env.TCB_LOG_DIR;
    logDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-logs-"));
    process.env.TCB_LOG_DIR = logDir;
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
    if (origLogDir === undefined) delete process.env.TCB_LOG_DIR;
    else process.env.TCB_LOG_DIR = origLogDir;
  });

  it("replies the no-context hint when there is no session and no arg", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });
    await sendLogs(channel, deps, "chat-1", undefined);
    expect(channel.texts().some((t) => t.includes("无当前会话"))).toBe(true);
    expect(channel.cards()).toHaveLength(0);
  });

  it("renders a logs view card when a current session supplies the filter", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-logs" });
    await sendLogs(channel, deps, "chat-1", undefined);
    expect(channel.cards()).toHaveLength(1);
    expect(JSON.stringify(channel.cards())).toContain("🪵 近期日志");
    // The card's reply target points back at the current session.
    expect(resolveReplyTarget("m1")).toBe("proj-logs");
  });
});

describe("sendInputs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("with no current project replies the short hint", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });
    await sendInputs(channel, deps, "chat-1", 8);
    expect(channel.texts()).toContain("无当前会话");
    expect(channel.cards()).toHaveLength(0);
  });

  it("without a path mapping replies the no-path hint", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-inputs-no-path" });
    await sendInputs(channel, deps, "chat-1", 8);
    expect(channel.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
  });

  it("with a path but no transcript replies 'no inputs'", async () => {
    const session = "proj-inputs-empty";
    setPathForSession(session, "/tmp/no-such-inputs-dir-xyz");
    const channel = fakeChannel();
    const deps = fakeDeps({ session });
    await sendInputs(channel, deps, "chat-1", 8);
    expect(channel.texts().some((t) => t.includes("没有可重发的输入"))).toBe(true);
  });

  it("with recorded inputs sends an inputs card and records the reply target", async () => {
    const session = "proj-inputs-list";
    const projectPath = "/proj/inputs/list";
    const configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-inputs-"));
    try {
      const histDir = projectPathToHistoryDir(projectPath, configRoot);
      fs.mkdirSync(histDir, { recursive: true });
      const mkLine = (type: string, content: string) =>
        JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
      fs.writeFileSync(
        nodePath.join(histDir, "a.jsonl"),
        `${[mkLine("user", "fix the failing test"), mkLine("assistant", "done")].join("\n")}\n`,
        "utf-8",
      );
      setPathForSession(session, projectPath);
      const channel = fakeChannel();
      const deps = fakeDeps({
        session,
        configResolver: { resolveConfigRoot: vi.fn(async () => configRoot) },
      });
      await sendInputs(channel, deps, "chat-1", 8);
      expect(channel.cards()).toHaveLength(1);
      expect(JSON.stringify(channel.cards())).toContain("fix the failing test");
      expect(resolveReplyTarget("m1")).toBe(session);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
});

describe("sendBrowse / group pickers", () => {
  it("sendBrowse sends the directory-browser card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ config: { cdAllowedDirs: ["/tmp"] } });
    await sendBrowse(channel, deps, "chat-1");
    expect(channel.cards()).toHaveLength(1);
  });

  it("sendGroupBindPicker sends a recent-project picker card", async () => {
    const channel = fakeChannel();
    await sendGroupBindPicker(channel, fakeDeps(), "chat-1");
    expect(channel.cards()).toHaveLength(1);
  });

  it("sendFreeGroupPicker sends a recent-project picker card", async () => {
    const channel = fakeChannel();
    await sendFreeGroupPicker(channel, fakeDeps(), "chat-1");
    expect(channel.cards()).toHaveLength(1);
  });

  it("sendFreeGroupPicker offers regular projects, not existing independent sessions", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-free-picker-"));
    const regularPath = nodePath.join(root, "regular");
    const freePath = nodePath.join(root, "free");
    fs.mkdirSync(regularPath);
    fs.mkdirSync(freePath);
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
    const { sessionNameFromPath } = await import("../../../src/core/projects/sessionPathMap.js");
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const { setFreeProject } = await import("../../../src/core/projects/free-projects.js");

    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => ["tmux_proj_free_8"]) },
    });
    const prefix = deps.config.projectSessionPrefix;
    await appendRecentProject(regularPath, prefix);
    setFreeProject(8, { label: "free-live" });
    setPathForSession("tmux_proj_free_8", freePath);
    const regularSid = sessionShortId(sessionNameFromPath(regularPath, prefix));
    const freeSid = sessionShortId("tmux_proj_free_8");

    const channel = fakeChannel();
    await sendFreeGroupPicker(channel, deps, "chat-1");

    const card = JSON.stringify(channel.cards());
    expect(card).toContain(regularSid);
    expect(card).not.toContain(freeSid);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("startOrPickAfterCreate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("with multiple configured launch commands shows the flavor picker card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      config: {
        startCommands: [
          { label: "claude", command: "bash" },
          { label: "codex", command: "bash" },
        ],
      },
    });
    await startOrPickAfterCreate(channel, deps, "chat-1", "proj-pick");
    expect(channel.cards()).toHaveLength(1);
    expect(channel.texts()).toHaveLength(0);
  });

  it("with a single command and a running agent replies 'already running'", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      config: { startCommands: [{ label: "claude", command: "bash" }] },
      agent: { checkIfRunning: vi.fn(async () => true) },
    });
    await startOrPickAfterCreate(channel, deps, "chat-1", "proj-already");
    expect(channel.texts().some((t) => t.includes("已在运行中"))).toBe(true);
  });

  it("with a single command and no agent running starts it and confirms", async () => {
    const channel = fakeChannel();
    const start = vi.fn(async () => {});
    const deps = fakeDeps({
      config: { startCommands: [{ label: "claude", command: "bash" }] },
      agent: { checkIfRunning: vi.fn(async () => false), start },
    });
    await startOrPickAfterCreate(channel, deps, "chat-1", "proj-fresh");
    expect(start).toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("已用「claude」启动"))).toBe(true);
  });
});

describe("addRecentBySid — created branch", () => {
  let allowedRoot: string;
  beforeEach(() => {
    vi.clearAllMocks();
    allowedRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-rsid-create-"));
  });
  afterEach(() => fs.rmSync(allowedRoot, { recursive: true, force: true }));

  it("creates the project then starts/confirms when the session does not yet exist", async () => {
    const channel = fakeChannel();
    const prefix = "tmux_proj_";
    const sessionName = `tmux_proj_${allowedRoot.replace(/\//g, "-")}`;
    const start = vi.fn(async () => {});
    const deps = fakeDeps({
      config: {
        cdAllowedDirs: [allowedRoot],
        projectSessionPrefix: prefix,
        sessionWarmupMs: 0,
        startCommands: [{ label: "claude", command: "bash" }],
        claudeStartCommand: "bash",
      },
      bridge: { hasSession: vi.fn(async () => false) },
      agent: { checkIfRunning: vi.fn(async () => false), start },
    });
    const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
    await appendRecentProject(allowedRoot, prefix);
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const sid = sessionShortId(sessionName);

    await addRecentBySid(channel, deps, "chat-1", sid);

    expect(deps.bridge.createSession).toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("项目已创建"))).toBe(true);
    expect(start).toHaveBeenCalled();
  });
});

describe("sendSessionsList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("with no current project replies the short hint", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });
    await sendSessionsList(channel, deps, "chat-1", undefined);
    expect(channel.texts()).toContain("无当前会话");
  });

  it("without a path mapping replies the no-path hint", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-sess-no-path" });
    await sendSessionsList(channel, deps, "chat-1", undefined);
    expect(channel.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
  });

  it("with a path but no saved sessions replies 'no sessions'", async () => {
    const session = "proj-sess-empty";
    setPathForSession(session, "/tmp/no-such-sessions-dir-xyz");
    const channel = fakeChannel();
    const deps = fakeDeps({ session });
    await sendSessionsList(channel, deps, "chat-1", undefined);
    expect(channel.texts().some((t) => t.includes("暂无保存的会话记录"))).toBe(true);
  });

  it("lists saved sessions (no arg) with a count title and resume hint", async () => {
    const session = "proj-sess-list";
    const projectPath = "/proj/sess/list";
    const configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-sess-"));
    try {
      const histDir = projectPathToHistoryDir(projectPath, configRoot);
      fs.mkdirSync(histDir, { recursive: true });
      const mkLine = (type: string, content: string) =>
        JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
      fs.writeFileSync(
        nodePath.join(histDir, "deadbeef-1234-1234-1234-1234567890ab.jsonl"),
        `${[mkLine("user", "q"), mkLine("assistant", "a")].join("\n")}\n`,
        "utf-8",
      );
      setPathForSession(session, projectPath);
      const channel = fakeChannel();
      const deps = fakeDeps({
        session,
        configResolver: { resolveConfigRoot: vi.fn(async () => configRoot) },
      });
      await sendSessionsList(channel, deps, "chat-1", undefined);
      const text = channel.texts().join("\n");
      expect(text).toContain("个会话记录");
      expect(text).toContain("/sessions");
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it("renders day-scale ages (formatAgo) for sessions older than a day", async () => {
    const session = "proj-sess-old";
    const projectPath = "/proj/sess/old";
    const configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-sess-old-"));
    try {
      const histDir = projectPathToHistoryDir(projectPath, configRoot);
      fs.mkdirSync(histDir, { recursive: true });
      const mkLine = (type: string, content: string) =>
        JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
      const file = nodePath.join(histDir, "cafef00d-1234-1234-1234-1234567890ab.jsonl");
      fs.writeFileSync(file, `${[mkLine("user", "q"), mkLine("assistant", "a")].join("\n")}\n`);
      // Backdate the transcript ~3 days so formatAgo takes its day-scale branch.
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      fs.utimesSync(file, old, old);
      setPathForSession(session, projectPath);
      const channel = fakeChannel();
      const deps = fakeDeps({
        session,
        configResolver: { resolveConfigRoot: vi.fn(async () => configRoot) },
      });
      await sendSessionsList(channel, deps, "chat-1", undefined);
      // ~3d age rendered (formatAgo's `Xd` branch).
      expect(channel.texts().some((t) => /\(\d+d\)/.test(t))).toBe(true);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it("with an arg matching no saved session replies 'no sessions'", async () => {
    const session = "proj-sess-arg-miss";
    setPathForSession(session, "/tmp/no-such-sessions-dir-arg");
    const channel = fakeChannel();
    const deps = fakeDeps({ session });
    await sendSessionsList(channel, deps, "chat-1", "abc123");
    expect(channel.texts().some((t) => t.includes("暂无保存的会话记录"))).toBe(true);
  });

  it("with an arg matching a saved session exits and resumes it", async () => {
    const session = "proj-sess-resume";
    const projectPath = "/proj/sess/resume";
    const configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lark-sess-resume-"));
    try {
      const histDir = projectPathToHistoryDir(projectPath, configRoot);
      fs.mkdirSync(histDir, { recursive: true });
      const mkLine = (type: string, content: string) =>
        JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
      const sessionId = "abcd1234-5678-90ab-cdef-1234567890ab";
      fs.writeFileSync(
        nodePath.join(histDir, `${sessionId}.jsonl`),
        `${[mkLine("user", "q"), mkLine("assistant", "a")].join("\n")}\n`,
        "utf-8",
      );
      setPathForSession(session, projectPath);
      const sendExit = vi.fn(async () => {});
      const startWithResume = vi.fn(async () => {});
      const channel = fakeChannel();
      const deps = fakeDeps({
        session,
        configResolver: { resolveConfigRoot: vi.fn(async () => configRoot) },
        bridge: { sendExit },
        agent: { startWithResume },
      });
      // sendSessionsList sleeps ~2s between exit and resume; allow real time.
      await sendSessionsList(channel, deps, "chat-1", "abcd1234");
      expect(sendExit).toHaveBeenCalledWith(session);
      expect(startWithResume).toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("已恢复会话"))).toBe(true);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  }, 10_000);
});
