import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aliveProjectButtons,
  createProjectFromPath,
  createProjectSession,
  recentProjectButtons,
  removeProjectBySession,
  resolveProjectPath,
} from "../../src/core/project-ops.js";
import { sessionNameFromPath, setPathForSession } from "../../src/core/sessionPathMap.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

vi.mock("../../src/core/recentProjects.js", () => ({
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
    const deps = fakeDeps({ claude: { checkIfRunning: vi.fn(async () => false) } });
    await removeProjectBySession(deps, "tmux_proj_a");
    expect(deps.bridge.sendExit).not.toHaveBeenCalled();
    expect(deps.bridge.killSession).toHaveBeenCalledWith("tmux_proj_a");
    expect(deps.currentProject.clearSession).toHaveBeenCalledWith("tmux_proj_a");
  });

  it("sends /exit and waits when Claude is running, then kills session", async () => {
    // First call (isRunning check) → true; subsequent calls in loop → false (graceful exit).
    const checkIfRunning = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const deps = fakeDeps({ claude: { checkIfRunning } });
    await removeProjectBySession(deps, "tmux_proj_b");
    expect(deps.bridge.sendExit).toHaveBeenCalledWith("tmux_proj_b");
    expect(deps.bridge.sendRawKey).not.toHaveBeenCalled();
    expect(deps.bridge.killSession).toHaveBeenCalledWith("tmux_proj_b");
  });

  it("falls back to Ctrl-C when Claude does not exit within the poll window", async () => {
    // Always running — triggers the C-c fallback after 10 polls.
    const deps = fakeDeps({ claude: { checkIfRunning: vi.fn(async () => true) } });
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
});

describe("recentProjectButtons", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-recent-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns empty array when there are no recent projects", async () => {
    const { readRecentProjectLines } = await import("../../src/core/recentProjects.js");
    vi.mocked(readRecentProjectLines).mockResolvedValueOnce([]);
    const deps = fakeDeps();
    const buttons = await recentProjectButtons(deps, "telegram");
    expect(buttons).toEqual([]);
  });

  it("filters out paths that no longer exist on disk", async () => {
    const { readRecentProjectLines } = await import("../../src/core/recentProjects.js");
    vi.mocked(readRecentProjectLines).mockResolvedValueOnce(["/nonexistent/path"]);
    const deps = fakeDeps();
    const buttons = await recentProjectButtons(deps, "telegram");
    expect(buttons).toEqual([]);
  });

  it("returns button with alive and active flags set correctly", async () => {
    const { readRecentProjectLines } = await import("../../src/core/recentProjects.js");
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
