import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPathToHistoryDir } from "../../src/core/agents/claude/claude-history.js";
import { projectLabel } from "../../src/core/projects/project-label.js";
import {
  aliveProjectButtons,
  createProjectFromPath,
  createProjectSession,
  recentProjectButtons,
  removeProjectBySession,
  resolveProjectPath,
} from "../../src/core/projects/project-ops.js";
import { sessionNameFromPath, setPathForSession } from "../../src/core/projects/sessionPathMap.js";
import type { AgentKind } from "../../src/shared/types.js";
import { sessionShortId } from "../../src/shared/utils/hash.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

vi.mock("../../src/core/projects/recentProjects.js", () => ({
  readRecentProjectLines: vi.fn(async () => []),
  appendRecentProject: vi.fn(async () => {}),
}));

vi.mock("../../src/shared/utils/sleep.js", () => ({
  sleep: vi.fn(async () => {}),
}));

describe("resolveProjectPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-pp-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("not-found for a missing path", async () => {
    const r = await resolveProjectPath(path.join(dir, "nope"), []);
    expect(r.error).toBe("not-found");
  });

  it("not-a-directory for a file", async () => {
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    const r = await resolveProjectPath(file, []);
    expect(r.error).toBe("not-a-directory");
  });

  it("not-allowed when outside the cd allow-list", async () => {
    const r = await resolveProjectPath(dir, ["/some/other/allowed/root"]);
    expect(r.error).toBe("not-allowed");
  });

  it("ok for an existing, allow-listed directory (empty allow-list = allow all)", async () => {
    const r = await resolveProjectPath(dir, []);
    expect(r.error).toBeUndefined();
    expect(r.resolvedPath).toBe(dir); // path.resolve of an already-absolute path
  });
});

describe("createProjectFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-cfp-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("maps a rejected path to an invalid status with the error", async () => {
    const deps = fakeDeps();
    const r = await createProjectFromPath(deps, "telegram", path.join(dir, "missing"));
    expect(r).toMatchObject({ status: "invalid", error: "not-found" });
  });

  it("switches to an existing session without creating a new one", async () => {
    const deps = fakeDeps({
      bridge: { hasSession: vi.fn(async () => true) },
      config: { cdAllowedDirs: [] },
    });
    const r = await createProjectFromPath(deps, "telegram", dir);
    expect(r.status).toBe("switched");
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    expect(deps.currentProject.set).toHaveBeenCalled();
  });

  it("creates a session when none exists yet", async () => {
    const deps = fakeDeps({
      bridge: { hasSession: vi.fn(async () => false) },
      config: { cdAllowedDirs: [] },
    });
    const r = await createProjectFromPath(deps, "lark", dir);
    expect(r).toMatchObject({ status: "created", projectPath: dir });
    expect(deps.bridge.createSession).toHaveBeenCalledWith(expect.any(String), dir);
  });

  it("refuses when a live session's name already belongs to a DIFFERENT path (collision guard)", async () => {
    const deps = fakeDeps({
      bridge: { hasSession: vi.fn(async () => true) },
      config: { cdAllowedDirs: [] },
    });
    // Pre-seed the path map so this dir's session name is owned by another path —
    // i.e. the /a/b-c vs /a-b/c collision. The guard must refuse, not switch.
    const session = sessionNameFromPath(dir, deps.config.projectSessionPrefix);
    setPathForSession(session, "/some/other/project");
    const r = await createProjectFromPath(deps, "telegram", dir);
    expect(r.status).toBe("error");
    expect((r as { message: string }).message).toContain("/some/other/project");
    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
  });
});

describe("createProjectSession", () => {
  it("creates the session in the project dir (-c) and sets it current — no shell cd typed", async () => {
    const deps = fakeDeps();
    await createProjectSession(deps, "lark", "tmux_proj_x", "/path/x");

    // The working dir is handed to tmux as new-session -c <path>, so the pane starts
    // there with no shell evaluation of the path (no injection on exotic paths).
    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_x", "/path/x");
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark", "tmux_proj_x");
    expect(deps.bridge.sendKeys).not.toHaveBeenCalled();
  });

  it("passes the channel through to currentProject.set", async () => {
    const deps = fakeDeps();
    await createProjectSession(deps, "telegram", "tmux_proj_y", "/path/y");
    expect(deps.currentProject.set).toHaveBeenCalledWith("telegram", "tmux_proj_y");
  });

  it("never types keys, even when the session already existed (createSession → false)", async () => {
    // A race or the `claude` helper already made the session — it may have Claude
    // running, so we must not type anything into its prompt. The -c only applies to
    // a freshly created pane; an existing one is left untouched.
    const deps = fakeDeps({ bridge: { createSession: vi.fn(async () => false) } });
    await createProjectSession(deps, "lark", "tmux_proj_z", "/path/z");

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_z", "/path/z");
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark", "tmux_proj_z");
    expect(deps.bridge.sendKeys).not.toHaveBeenCalled();
  });
});

describe("removeProjectBySession", () => {
  it("skips exit sequence when Claude is not running", async () => {
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => false) } });
    await removeProjectBySession(deps, "tmux_proj_a");
    expect(deps.bridge.sendExit).not.toHaveBeenCalled();
    expect(deps.bridge.killSession).toHaveBeenCalledWith("tmux_proj_a");
    expect(deps.currentProject.clearSession).toHaveBeenCalledWith("tmux_proj_a");
  });

  it("sends /exit and waits when Claude is running, then kills session", async () => {
    // First call (isRunning check) → true; subsequent calls in loop → false (graceful exit).
    const checkIfRunning = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const deps = fakeDeps({ agent: { checkIfRunning } });
    await removeProjectBySession(deps, "tmux_proj_b");
    expect(deps.bridge.sendExit).toHaveBeenCalledWith("tmux_proj_b");
    expect(deps.bridge.sendRawKey).not.toHaveBeenCalled();
    expect(deps.bridge.killSession).toHaveBeenCalledWith("tmux_proj_b");
  });

  it("falls back to Ctrl-C when Claude does not exit within the poll window", async () => {
    // Always running — triggers the C-c fallback after 10 polls.
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });
    await removeProjectBySession(deps, "tmux_proj_c");
    expect(deps.bridge.sendRawKey).toHaveBeenCalledWith("C-c", "tmux_proj_c");
    expect(deps.bridge.killSession).toHaveBeenCalledWith("tmux_proj_c");
  });
});

describe("aliveProjectButtons", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-alive-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns empty array when there are no project sessions", async () => {
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });
    const buttons = await aliveProjectButtons(deps, "telegram");
    expect(buttons).toEqual([]);
  });

  it("filters out sessions whose paths no longer exist", async () => {
    const session = "tmux_proj_-gone";
    setPathForSession(session, "/nonexistent/path");
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
    });
    const buttons = await aliveProjectButtons(deps, "telegram");
    expect(buttons).toEqual([]);
  });

  it("marks the active session and returns button data", async () => {
    const session = "tmux_proj_-home-user-app";
    setPathForSession(session, dir);
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      currentProject: { get: vi.fn(async () => session) },
      session: session,
    });
    const buttons = await aliveProjectButtons(deps, "telegram");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.active).toBe(true);
    expect(buttons[0]?.sid).toBeTruthy();
  });

  it("shows 💤 when no agent is live in the pane", async () => {
    const session = "tmux_proj_-home-user-idle";
    setPathForSession(session, dir);
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      configResolver: { detectAgentKind: vi.fn(async () => null) },
    });
    const buttons = await aliveProjectButtons(deps, "telegram");
    expect(buttons[0]?.label).toContain("💤");
  });

  it("shows 🟠 for a live claude session and 🔘 for a live codex session", async () => {
    const session = "tmux_proj_-home-user-agent";
    setPathForSession(session, dir);
    const claudeDeps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude") },
    });
    const codexDeps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "codex") },
    });
    expect((await aliveProjectButtons(claudeDeps, "telegram"))[0]?.label).toContain("🟠");
    expect((await aliveProjectButtons(codexDeps, "telegram"))[0]?.label).toContain("🔘");
  });

  it("shows ⏳ when the queue is processing the session", async () => {
    const session = "tmux_proj_-home-user-busy";
    setPathForSession(session, dir);
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude") },
      queue: { isSessionProcessing: vi.fn(() => true) },
    });
    expect((await aliveProjectButtons(deps, "telegram"))[0]?.label).toContain("⏳");
  });

  it("shows ⏳ when a message is waiting in the session queue (not yet processing)", async () => {
    const session = "tmux_proj_-home-user-queued";
    setPathForSession(session, dir);
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude") },
      queue: {
        isSessionProcessing: vi.fn(() => false),
        getSessionQueue: vi.fn(() => [{ id: "m1" }] as never),
      },
    });
    expect((await aliveProjectButtons(deps, "telegram"))[0]?.label).toContain("⏳");
  });

  it("shows ⏳ when the agent transcript was just written (active even with an idle queue)", async () => {
    const session = "tmux_proj_-active";
    setPathForSession(session, dir);
    // A fresh claude transcript under a temp config root → active within the window.
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-cfg-"));
    const histDir = projectPathToHistoryDir(dir, cfg);
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, "00000000-0000-4000-8000-000000000000.jsonl"), "x\n");
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [session]),
        paneCurrentPath: vi.fn(async () => dir),
      },
      configResolver: {
        detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude"),
        resolveConfigRoot: vi.fn(async () => cfg),
      },
      queue: { isSessionProcessing: vi.fn(() => false), getSessionQueue: vi.fn(() => []) },
    });
    expect((await aliveProjectButtons(deps, "telegram"))[0]?.label).toContain("⏳");
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  it("shows ⏳ from the activity event source even when the transcript mtime is stale", async () => {
    const session = "tmux_proj_-event-active";
    setPathForSession(session, dir);
    // A STALE transcript on disk (mtime set well past the idle window): the stat
    // fallback alone would yield false. The fs.watch-backed activity watcher
    // reports a recent write, so the session still reads as actively working —
    // proving the event source, not stat, produced the ⏳ (idle queue, live claude).
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-evt-"));
    const histDir = projectPathToHistoryDir(dir, cfg);
    fs.mkdirSync(histDir, { recursive: true });
    const file = path.join(histDir, "00000000-0000-4000-8000-000000000001.jsonl");
    fs.writeFileSync(file, "x\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [session]),
        paneCurrentPath: vi.fn(async () => dir),
      },
      configResolver: {
        detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude"),
        resolveConfigRoot: vi.fn(async () => cfg),
      },
      queue: { isSessionProcessing: vi.fn(() => false), getSessionQueue: vi.fn(() => []) },
      activity: { isActiveWithin: () => true },
    });
    expect((await aliveProjectButtons(deps, "telegram"))[0]?.label).toContain("⏳");
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  it("degrades a session to its plain label when its decoration probe rejects (others survive)", async () => {
    // One wedged pane: paneCurrentPath rejects for it. The other session must
    // still return, and the failed one falls back to its plain base label — no
    // ⚠️ glyph, no throw that would blank the whole list.
    const wedged = "tmux_proj_-home-user-wedged";
    const ok = "tmux_proj_-home-user-ok";
    setPathForSession(wedged, dir);
    setPathForSession(ok, dir);
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [wedged, ok]),
        paneCurrentPath: vi.fn(async (session?: string) => {
          if (session === wedged) throw new Error("pane is wedged");
          return dir;
        }),
      },
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude") },
    });
    const buttons = await aliveProjectButtons(deps, "telegram");
    expect(buttons).toHaveLength(2);
    const wedgedBtn = buttons.find((b) => b.sid === sessionShortId(wedged));
    const okBtn = buttons.find((b) => b.sid === sessionShortId(ok));
    // Failed one degrades to the plain projectLabel — no agent/⚠️ decoration.
    expect(wedgedBtn?.label).toBe(projectLabel(wedged, dir));
    expect(wedgedBtn?.label).not.toContain("⚠️");
    // The healthy one still gets its full decoration.
    expect(okBtn?.label).toContain("🟠");
  });

  it("shows ⚠️ when the pane cwd differs from the bound dir (agent live)", async () => {
    const session = "tmux_proj_-home-user-drift";
    setPathForSession(session, dir);
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [session]),
        paneCurrentPath: vi.fn(async () => "/somewhere/else"),
      },
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude") },
    });
    expect((await aliveProjectButtons(deps, "telegram"))[0]?.label).toContain("⚠️");
  });

  it("no ⚠️ when the pane cwd matches the bound dir", async () => {
    const session = "tmux_proj_-home-user-match";
    setPathForSession(session, dir);
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [session]),
        paneCurrentPath: vi.fn(async () => dir),
      },
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude") },
    });
    expect((await aliveProjectButtons(deps, "telegram"))[0]?.label).not.toContain("⚠️");
  });

  it("no ⚠️ when no agent is live, even if cwd differs", async () => {
    const session = "tmux_proj_-home-user-noagent-drift";
    setPathForSession(session, dir);
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [session]),
        paneCurrentPath: vi.fn(async () => "/somewhere/else"),
      },
      configResolver: { detectAgentKind: vi.fn(async () => null) },
    });
    expect((await aliveProjectButtons(deps, "telegram"))[0]?.label).not.toContain("⚠️");
  });
});

describe("recentProjectButtons", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-recent-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns empty array when there are no recent projects", async () => {
    const { readRecentProjectLines } = await import("../../src/core/projects/recentProjects.js");
    vi.mocked(readRecentProjectLines).mockResolvedValueOnce([]);
    const deps = fakeDeps();
    const buttons = await recentProjectButtons(deps, "telegram");
    expect(buttons).toEqual([]);
  });

  it("filters out paths that no longer exist on disk", async () => {
    const { readRecentProjectLines } = await import("../../src/core/projects/recentProjects.js");
    vi.mocked(readRecentProjectLines).mockResolvedValueOnce(["/nonexistent/path"]);
    const deps = fakeDeps();
    const buttons = await recentProjectButtons(deps, "telegram");
    expect(buttons).toEqual([]);
  });

  it("returns button with alive and active flags set correctly", async () => {
    const { readRecentProjectLines } = await import("../../src/core/projects/recentProjects.js");
    vi.mocked(readRecentProjectLines).mockResolvedValueOnce([dir]);
    const sessionName = `tmux_proj_${dir.replace(/\//g, "-")}`;
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [sessionName]) },
      currentProject: { get: vi.fn(async () => sessionName) },
      session: sessionName,
    });
    const buttons = await recentProjectButtons(deps, "telegram");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.alive).toBe(true);
    expect(buttons[0]?.active).toBe(true);
  });
});
