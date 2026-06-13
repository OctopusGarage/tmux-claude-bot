import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aliveProjectButtons,
  createProjectSession,
  recentProjectButtons,
  removeProjectBySession,
  resolveProjectPath,
} from "../../src/core/project-ops.js";
import { setPathForSession } from "../../src/core/sessionPathMap.js";
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

describe("createProjectSession", () => {
  it("creates the session, sets it current, and cds into the EXPLICIT session", async () => {
    const deps = fakeDeps();
    await createProjectSession(deps, "lark", "tmux_proj_x", "/path/x");

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_x");
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark", "tmux_proj_x");
    // The cd MUST target the named session, not the channel default — otherwise a
    // Feishu create could land its cd in Telegram's current session.
    expect(deps.bridge.sendKeys).toHaveBeenCalledWith('cd "/path/x"', "tmux_proj_x");
  });

  it("passes the channel through to currentProject.set", async () => {
    const deps = fakeDeps();
    await createProjectSession(deps, "telegram", "tmux_proj_y", "/path/y");
    expect(deps.currentProject.set).toHaveBeenCalledWith("telegram", "tmux_proj_y");
  });

  it("does NOT cd when the session already existed (createSession → false)", async () => {
    // A race or the `claude` helper already made the session — it may have Claude
    // running, so a stray `cd` would be typed into its prompt. Skip it.
    const deps = fakeDeps({ bridge: { createSession: vi.fn(async () => false) } });
    await createProjectSession(deps, "lark", "tmux_proj_z", "/path/z");

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_z");
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
