import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock createBoundChat so no real SDK/network calls happen.
const createBoundChat = vi.fn();
vi.mock(import("../../../src/adapters/lark/resource.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBoundChat: (...args: unknown[]) => createBoundChat(...args) };
});

const {
  handleNewGroup,
  handleBind,
  handleUnbind,
  handleRestore,
  makeBoundGroupBySid,
  bindCurrentGroupBySid,
} = await import("../../../src/adapters/lark/group-commands.js");
const { fakeChannel, fakeDeps } = await import("./_fakes.js");
const { bindGroup, getBinding } = await import("../../../src/core/group-bindings.js");
const { setPathForSession, sessionNameFromPath } = await import(
  "../../../src/core/sessionPathMap.js"
);
const { appendRecentProject } = await import("../../../src/core/recentProjects.js");
const { sessionShortId } = await import("../../../src/shared/utils/hash.js");

/**
 * Default locale is zh (see src/core/i18n/index.ts: DEFAULT_UI_LANG = "zh").
 * zh strings for group binding messages:
 *   groupNewGroupOnlyInP2p  → "`/newgroup` 仅在与机器人的私聊中有效。"
 *   groupTargetUsage        → "用法：`<命令> <绝对路径 | ~/路径 | 工作区名称>`"
 *   groupCreateFailed(msg)  → `❌ 创建群组失败：${msg}…`
 *   groupBoundWelcome(l,p)  → `🎉 群组已绑定到 **${l}**…`
 *   groupBindOnlyInGroup    → "在私聊中请使用 `/newgroup`，`/bind` 仅在群组内有效。"
 *   groupUnbindOnlyInGroup  → "在私聊中无法解绑，`/unbind` 仅在群组内有效。"
 *   groupUnbound            → "🔓 此群组已解除与工作区的绑定。"
 *   groupNotBound           → "此群组尚未绑定工作区。"
 *   groupRestored(label)    → `🔄 已恢复此群组 → **${label}**。`
 *   groupMissingPath(label) → `⚠️ **${label}** 的工作区路径已不存在。`
 */

describe("group-commands", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-grpcmd-"));
    process.env.TCB_STATE_DIR = dir;
    createBoundChat.mockReset();
  });

  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  // ── handleNewGroup ──────────────────────────────────────────────────────────

  describe("handleNewGroup", () => {
    it("replies groupNewGroupOnlyInP2p and does not call createBoundChat when chatType is group", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewGroup(channel, deps, "oc_g1", "group", "ou_me", dir);
      expect(channel.texts().some((t) => t.includes("仅在与机器人的私聊中有效"))).toBe(true);
      expect(createBoundChat).not.toHaveBeenCalled();
    });

    it("replies usage text and does not call createBoundChat when arg is undefined", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", undefined);
      expect(channel.texts().some((t) => t.includes("用法"))).toBe(true);
      expect(createBoundChat).not.toHaveBeenCalled();
    });

    it("replies an error and does not call createBoundChat when path is not in cdAllowedDirs", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: ["/home/other"] } });
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      expect(channel.texts().some((t) => t.includes("❌"))).toBe(true);
      expect(createBoundChat).not.toHaveBeenCalled();
    });

    it("calls createBoundChat, binds group, creates session, and sends welcome on success", async () => {
      createBoundChat.mockResolvedValue({ chatId: "oc_new", name: "myproj" });
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);

      expect(createBoundChat).toHaveBeenCalledOnce();
      expect(getBinding("oc_new")).not.toBeNull();
      expect(deps.bridge.createSession).toHaveBeenCalled();
      // Two welcome messages: one to the new group, one back to the p2p chat
      expect(channel.texts().filter((t) => t.includes("群组已绑定到")).length).toBe(2);
      // Feature D: the bound-project card is sent into the new group.
      expect(JSON.stringify(channel.cards())).toContain("本群已绑定");
    });

    it("replies groupCreateFailed and does not persist a binding when createBoundChat rejects", async () => {
      createBoundChat.mockRejectedValue(new Error("nope"));
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);

      expect(channel.texts().some((t) => t.includes("nope"))).toBe(true);
      // No binding should have been persisted under any id
      expect(getBinding("oc_new")).toBeNull();
    });

    it("rejects creating a second group when the workspace already has one", async () => {
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      const sessionName = sessionNameFromPath(dir, deps.config.projectSessionPrefix);
      bindGroup("oc_existing", { workspacePath: dir, sessionName, label: "x" });
      const channel = fakeChannel();
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      expect(createBoundChat).not.toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("已经有绑定群"))).toBe(true);
    });
  });

  // ── handleBind ──────────────────────────────────────────────────────────────

  describe("handleBind", () => {
    it("replies groupBindOnlyInGroup when chatType is p2p", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleBind(channel, deps, "ou_me", "p2p", dir);
      expect(channel.texts().some((t) => t.includes("/bind` 仅在群组内有效"))).toBe(true);
    });

    it("binds the group, creates session, and sends welcome when valid path given in a group", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      setPathForSession("tmux_proj_-tmp-placeholder", dir); // ensure path map can be written
      await handleBind(channel, deps, "oc_bind1", "group", dir);

      expect(getBinding("oc_bind1")).not.toBeNull();
      expect(deps.bridge.createSession).toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("群组已绑定到"))).toBe(true);
    });

    it("rejects binding to a project ANOTHER group already owns", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      const sessionName = sessionNameFromPath(dir, deps.config.projectSessionPrefix);
      bindGroup("oc_other", { workspacePath: dir, sessionName, label: "x" });

      await handleBind(channel, deps, "oc_bind2", "group", dir);

      expect(getBinding("oc_bind2")).toBeNull();
      expect(deps.bridge.createSession).not.toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("已经有绑定群"))).toBe(true);
    });
  });

  // ── handleUnbind ────────────────────────────────────────────────────────────

  describe("handleUnbind", () => {
    it("replies groupUnbindOnlyInGroup when chatType is p2p", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      await handleUnbind(channel, deps, "ou_me", "p2p");
      expect(channel.texts().some((t) => t.includes("/unbind` 仅在群组内有效"))).toBe(true);
    });

    it("unbinds an existing binding and replies groupUnbound", async () => {
      bindGroup("oc_del1", { workspacePath: dir, sessionName: "sess-a", label: "projA" });
      const channel = fakeChannel();
      const deps = fakeDeps();
      await handleUnbind(channel, deps, "oc_del1", "group");
      expect(channel.texts().some((t) => t.includes("已解除与工作区的绑定"))).toBe(true);
      expect(getBinding("oc_del1")).toBeNull();
    });

    it("replies groupNotBound when no binding exists for the group", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      await handleUnbind(channel, deps, "oc_unbound_x", "group");
      expect(channel.texts().some((t) => t.includes("尚未绑定工作区"))).toBe(true);
    });
  });

  // ── handleRestore ───────────────────────────────────────────────────────────

  describe("handleRestore", () => {
    it("replies groupNotBound when no binding exists", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      await handleRestore(channel, deps, "oc_no_binding");
      expect(channel.texts().some((t) => t.includes("尚未绑定工作区"))).toBe(true);
    });

    it("replies groupMissingPath when the bound workspacePath does not exist on disk", async () => {
      const gonePath = join(dir, "gone");
      bindGroup("oc_gone", { workspacePath: gonePath, sessionName: "sess-b", label: "projB" });
      setPathForSession("sess-b", gonePath);
      const channel = fakeChannel();
      const deps = fakeDeps();
      await handleRestore(channel, deps, "oc_gone");
      expect(channel.texts().some((t) => t.includes("路径已不存在"))).toBe(true);
    });

    it("replies groupRestored when reconcile succeeds (session alive, pointer matches)", async () => {
      bindGroup("oc_live", { workspacePath: dir, sessionName: "sess-c", label: "projC" });
      setPathForSession("sess-c", dir);
      const channel = fakeChannel();
      const deps = fakeDeps({
        bridge: { hasSession: vi.fn(async () => true) },
        currentProject: { get: vi.fn(async () => "sess-c") },
      });
      await handleRestore(channel, deps, "oc_live");
      expect(channel.texts().some((t) => t.includes("已恢复此群组"))).toBe(true);
      expect(channel.texts().some((t) => t.includes("projC"))).toBe(true);
    });
  });

  // ── button-driven (sid) ──────────────────────────────────────────────────────

  describe("makeBoundGroupBySid", () => {
    it("creates+binds a group for a recent project picked by short id", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      createBoundChat.mockResolvedValue({ chatId: "oc_made", name: "x" });
      const channel = fakeChannel();

      await makeBoundGroupBySid(channel, deps, "oc_p2p", sid, "ou_me");

      expect(createBoundChat).toHaveBeenCalled();
      expect(getBinding("oc_made")?.workspacePath).toBe(dir);
      expect(deps.bridge.createSession).toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("已新建项目群"))).toBe(true);
    });

    it("replies shortIdNotFound and does not create a group for an unknown sid", async () => {
      const deps = fakeDeps();
      const channel = fakeChannel();
      await makeBoundGroupBySid(channel, deps, "oc_p2p", "nope", "ou_me");
      expect(createBoundChat).not.toHaveBeenCalled();
    });

    it("rejects a second group for an already-grouped recent project", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sessionName = sessionNameFromPath(dir, deps.config.projectSessionPrefix);
      bindGroup("oc_existing", { workspacePath: dir, sessionName, label: "x" });
      const channel = fakeChannel();
      await makeBoundGroupBySid(channel, deps, "oc_p2p", sessionShortId(sessionName), "ou_me");
      expect(createBoundChat).not.toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("已经有绑定群"))).toBe(true);
    });
  });

  describe("bindCurrentGroupBySid", () => {
    it("binds the current group to a recent project picked by short id", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      const channel = fakeChannel();

      await bindCurrentGroupBySid(channel, deps, "oc_grp", sid);

      expect(getBinding("oc_grp")?.workspacePath).toBe(dir);
      expect(channel.texts().some((t) => t.includes("群组已绑定到"))).toBe(true);
    });

    it("rejects rebinding to a project ANOTHER group already owns", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sessionName = sessionNameFromPath(dir, deps.config.projectSessionPrefix);
      bindGroup("oc_other", { workspacePath: dir, sessionName, label: "x" });
      const channel = fakeChannel();

      await bindCurrentGroupBySid(channel, deps, "oc_grp", sessionShortId(sessionName));

      expect(getBinding("oc_grp")).toBeNull(); // not bound
      expect(deps.bridge.createSession).not.toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("已经有绑定群"))).toBe(true);
    });

    it("lets a group re-anchor to its OWN project (self is not a conflict)", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sessionName = sessionNameFromPath(dir, deps.config.projectSessionPrefix);
      bindGroup("oc_grp", { workspacePath: dir, sessionName, label: "x" });
      const channel = fakeChannel();

      await bindCurrentGroupBySid(channel, deps, "oc_grp", sessionShortId(sessionName));

      expect(getBinding("oc_grp")?.workspacePath).toBe(dir);
      expect(channel.texts().some((t) => t.includes("群组已绑定到"))).toBe(true);
    });
  });
});
