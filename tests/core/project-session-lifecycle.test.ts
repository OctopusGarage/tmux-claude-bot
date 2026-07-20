import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreeProject } from "../../src/core/projects/free-projects.js";
import {
  createFreeProject,
  createProjectSession,
  switchToProject,
} from "../../src/core/projects/project-session-lifecycle.js";
import { setPathForSession } from "../../src/core/projects/sessionPathMap.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

vi.mock("../../src/core/projects/recentProjects.js", () => ({
  appendRecentProject: vi.fn(async () => {}),
}));

let stateDir: string;
let originalStateDir: string | undefined;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-lifecycle-"));
  originalStateDir = process.env.TCB_STATE_DIR;
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("project-session lifecycle", () => {
  it("creates a regular project session and records every lifecycle fact", async () => {
    const { appendRecentProject } = await import("../../src/core/projects/recentProjects.js");
    const deps = fakeDeps({ config: { projectSessionPrefix: "tmux_proj" } });

    await createProjectSession(deps, "telegram", "tmux_proj_app", "/workspace/app");

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_app", "/workspace/app");
    expect(deps.currentProject.set).toHaveBeenCalledWith("telegram", "tmux_proj_app");
    expect(appendRecentProject).toHaveBeenCalledWith("/workspace/app", "tmux_proj");
  });

  it("switches the chat scope to an existing project session and refreshes recents", async () => {
    const { appendRecentProject } = await import("../../src/core/projects/recentProjects.js");
    const deps = fakeDeps({ config: { projectSessionPrefix: "tmux_proj" } });
    setPathForSession("tmux_proj_existing", "/workspace/existing");

    await switchToProject(deps, "lark:chat-1", "tmux_proj_existing");

    expect(deps.currentProject.set).toHaveBeenCalledWith("lark:chat-1", "tmux_proj_existing");
    expect(appendRecentProject).toHaveBeenCalledWith("/workspace/existing", "tmux_proj");
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
  });

  it("creates an independent project session and records the slot lifecycle fact", async () => {
    const deps = fakeDeps({
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: { listProjectSessions: vi.fn(async () => []) },
    });

    const result = await createFreeProject(deps, "telegram:1", "feature-x");

    expect(result).toEqual({ status: "created", sessionName: "tmux_proj_free_1", slot: 1 });
    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_free_1");
    expect(deps.currentProject.set).toHaveBeenCalledWith("telegram:1", "tmux_proj_free_1");
    expect(getFreeProject(1)?.label).toBe("feature-x");
  });
});
