import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock createBoundChat so no real SDK/network calls happen.
const createBoundChat = vi.fn();
vi.mock(import("../../../src/adapters/lark/resource.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBoundChat: (...args: unknown[]) => createBoundChat(...args) };
});

const {
  handleNewGroup,
  handleNewFreeGroup,
  handleBind,
  handleUnbind,
  handleRestore,
  makeBoundGroupBySid,
  makeFreeGroupBySid,
  bindCurrentGroupBySid,
} = await import("../../../src/adapters/lark/group-commands.js");
const { fakeChannel, fakeDeps } = await import("./_fakes.js");
const { bindGroup, getBinding } = await import("../../../src/core/projects/group-bindings.js");
const { setPathForSession, sessionNameFromPath } = await import(
  "../../../src/core/projects/sessionPathMap.js"
);
const { saveWorkspace } = await import("../../../src/core/projects/workspaces.js");
const { setFreeProject, FREE_PROJECT_LIMIT } = await import(
  "../../../src/core/projects/free-projects.js"
);
const { appendRecentProject } = await import("../../../src/core/projects/recentProjects.js");
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
      // The new group gets the full home menu — work-surface shortcuts (peek) AND
      // binding management (unbind) — so the user can act immediately, instead of
      // an unbind-only card.
      const cards = JSON.stringify(channel.cards());
      expect(cards).toContain('"peek"');
      expect(cards).toContain('"unbind"');
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

    it("stringifies a non-Error rejection from createBoundChat", async () => {
      createBoundChat.mockRejectedValue({ weird: "object" }); // not an Error instance
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      // String({weird}) → "[object Object]" surfaces in the failure message.
      expect(channel.texts().some((t) => t.includes("[object Object]"))).toBe(true);
    });

    it("no-ops after the target resolves when lark config is absent", async () => {
      // Passes policy + path validation, then the `!deps.config.lark` guard returns
      // before any group is created. (Defensive: prod always has lark configured.)
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir], lark: undefined } });
      const channel = fakeChannel();
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      expect(createBoundChat).not.toHaveBeenCalled();
      expect(getBinding("oc_new")).toBeNull();
    });

    it("replies the bare error (no resolvedPath) for an unknown workspace name", async () => {
      // A workspace name mapped to a session with NO path → resolveWorkspaceTarget
      // returns { error: 'unknown-workspace' } and NO resolvedPath, so the reply
      // takes the `: ""` branch (no `: <path>` suffix).
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      saveWorkspace("ghostws", "tmux_proj_no_such_path_session");
      const channel = fakeChannel();
      await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", "ghostws");
      const errText = channel.texts().find((t) => t.includes("❌"));
      expect(errText).toBeDefined();
      expect(errText).not.toContain(":"); // no "<error>: <resolvedPath>" suffix
      expect(createBoundChat).not.toHaveBeenCalled();
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
      // /bind now also lands the full home menu (peek + management), not text only.
      const cards = JSON.stringify(channel.cards());
      expect(cards).toContain('"peek"');
      expect(cards).toContain('"unbind"');
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

    it("replies usage and does not bind when arg is undefined (null target)", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleBind(channel, deps, "oc_bind_noarg", "group", undefined);
      expect(channel.texts().some((t) => t.includes("用法"))).toBe(true);
      expect(getBinding("oc_bind_noarg")).toBeNull();
      expect(deps.bridge.createSession).not.toHaveBeenCalled();
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

    it("no-ops (warns) when lark config is absent", async () => {
      const deps = fakeDeps({ config: { lark: undefined } });
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      const channel = fakeChannel();
      await makeBoundGroupBySid(channel, deps, "oc_p2p", sid, "ou_me");
      // The no-lark guard returns before resolving the path or creating anything.
      expect(createBoundChat).not.toHaveBeenCalled();
      expect(channel.texts()).toHaveLength(0);
    });

    it("replies groupCreateFailed with a stringified non-Error when createBoundChat throws a literal", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      createBoundChat.mockRejectedValue("plain string boom"); // not an Error instance
      const channel = fakeChannel();
      await makeBoundGroupBySid(channel, deps, "oc_p2p", sid, "ou_me");
      expect(channel.texts().some((t) => t.includes("plain string boom"))).toBe(true);
      expect(getBinding("oc_new")).toBeNull();
    });

    it("uses err.message when createBoundChat rejects with an Error", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      createBoundChat.mockRejectedValue(new Error("sdk exploded"));
      const channel = fakeChannel();
      await makeBoundGroupBySid(channel, deps, "oc_p2p", sid, "ou_me");
      expect(channel.texts().some((t) => t.includes("sdk exploded"))).toBe(true);
      expect(getBinding("oc_new")).toBeNull();
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

    it("replies shortIdNotFound and does not bind for an unknown sid", async () => {
      const deps = fakeDeps();
      const channel = fakeChannel();
      await bindCurrentGroupBySid(channel, deps, "oc_grp_x", "unknownsid");
      expect(getBinding("oc_grp_x")).toBeNull();
      expect(deps.bridge.createSession).not.toHaveBeenCalled();
    });
  });

  // ── free parallel groups ──────────────────────────────────────────────────────

  describe("makeFreeGroupBySid", () => {
    it("replies shortIdNotFound and creates nothing for an unknown sid", async () => {
      const deps = fakeDeps();
      const channel = fakeChannel();
      await makeFreeGroupBySid(channel, deps, "oc_p2p", "ghost-sid", "ou_me");
      expect(createBoundChat).not.toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes("未找到短 id"))).toBe(true);
    });
  });

  describe("handleNewFreeGroup", () => {
    it("refuses with the p2p-only policy message inside a group", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewFreeGroup(channel, deps, "oc_g1", "group", "ou_me", dir);
      expect(channel.texts().some((t) => t.includes("仅在与机器人的私聊中有效"))).toBe(true);
      expect(createBoundChat).not.toHaveBeenCalled();
    });

    it("replies usage and creates nothing when arg is undefined", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewFreeGroup(channel, deps, "ou_me", "p2p", "ou_me", undefined);
      expect(channel.texts().some((t) => t.includes("用法"))).toBe(true);
      expect(createBoundChat).not.toHaveBeenCalled();
    });

    it("creates a fresh free-session group on an allowed path (label gets a #1 index)", async () => {
      createBoundChat.mockResolvedValue({ chatId: "oc_free_new", name: "x" });
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewFreeGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);

      expect(createBoundChat).toHaveBeenCalledOnce();
      const created = getBinding("oc_free_new");
      expect(created?.workspacePath).toBe(dir);
      expect(created?.sessionName).toMatch(/^tmux_proj_free_\d+$/);
      expect(created?.label).toBe(`${basename(dir)} #1`);
      expect(channel.texts().some((t) => t.includes("已创建平行群"))).toBe(true);
    });

    it("replies the free-project limit and creates nothing when all slots are taken", async () => {
      // Fill every free slot so allocateFreeSlotPruned returns null.
      for (let n = 1; n <= FREE_PROJECT_LIMIT; n++) {
        setFreeProject(n, { label: `taken-${n}` });
        bindGroup(`oc_full_${n}`, {
          workspacePath: `/x/${n}`,
          sessionName: `tmux_proj_free_${n}`,
          label: `taken-${n}`,
        });
      }
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewFreeGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      expect(createBoundChat).not.toHaveBeenCalled();
      expect(channel.texts().some((t) => t.includes(String(FREE_PROJECT_LIMIT)))).toBe(true);
    });

    it("stringifies a non-Error rejection from createBoundChat", async () => {
      createBoundChat.mockRejectedValue(404); // a number, not an Error
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewFreeGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      expect(channel.texts().some((t) => t.includes("404"))).toBe(true);
    });

    it("uses err.message when createBoundChat rejects with an Error", async () => {
      createBoundChat.mockRejectedValue(new Error("free sdk down"));
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await handleNewFreeGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      expect(channel.texts().some((t) => t.includes("free sdk down"))).toBe(true);
    });

    it("no-ops after slot allocation when lark config is absent", async () => {
      // Defensive `!deps.config.lark` guard in createFreeGroupAtPath: returns
      // before creating a chat even though a free slot was allocated.
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir], lark: undefined } });
      const channel = fakeChannel();
      await handleNewFreeGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
      expect(createBoundChat).not.toHaveBeenCalled();
    });
  });
});
