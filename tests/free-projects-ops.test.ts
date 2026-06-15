import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_PROJECT_LIMIT, getFreeProject, setFreeProject } from "../src/core/free-projects.js";
import { bindGroup, getBinding } from "../src/core/group-bindings.js";
import {
  aliveProjectButtons,
  createFreeProject,
  removeProjectBySession,
} from "../src/core/project-ops.js";

let dir: string;
let orig: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-freeops-"));
  orig = process.env.TCB_STATE_DIR;
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (orig === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = orig;
});

// Minimal deps double — only the fields createFreeProject touches. `live` is the
// set of tmux sessions listProjectSessions() reports (drives the dead-slot prune).
function makeDeps(opts: { live?: string[] } = {}) {
  const createSession = vi.fn().mockResolvedValue(true);
  const set = vi.fn().mockResolvedValue(undefined);
  const listProjectSessions = vi.fn().mockResolvedValue(opts.live ?? []);
  return {
    deps: {
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: { createSession, listProjectSessions },
      currentProject: { set },
    } as never,
    createSession,
    set,
  };
}

const allFreeNames = (n: number) => Array.from({ length: n }, (_, i) => `tmux_proj_free_${i + 1}`);

describe("createFreeProject", () => {
  it("allocates a bare session, records the slot, sets it current", async () => {
    const { deps, createSession, set } = makeDeps();
    const res = await createFreeProject(deps, "telegram:1", "feature-x");
    expect(res).toEqual({ status: "created", sessionName: "tmux_proj_free_1", slot: 1 });
    expect(createSession).toHaveBeenCalledWith("tmux_proj_free_1");
    expect(set).toHaveBeenCalledWith("telegram:1", "tmux_proj_free_1");
    expect(getFreeProject(1)?.label).toBe("feature-x");
  });

  it("stores label null when none given", async () => {
    const { deps } = makeDeps();
    await createFreeProject(deps, "telegram:1", "");
    expect(getFreeProject(1)?.label).toBeNull();
  });

  it("refuses only when the cap is reached by LIVE sessions", async () => {
    for (let n = 1; n <= FREE_PROJECT_LIMIT; n++) setFreeProject(n, { label: null });
    // all 10 slots are alive → genuinely full
    const { deps, createSession } = makeDeps({ live: allFreeNames(FREE_PROJECT_LIMIT) });
    const res = await createFreeProject(deps, "telegram:1", "x");
    expect(res).toEqual({ status: "limit" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("prunes dead slots before allocating (no false 'limit')", async () => {
    // registry says 1..10 are used, but tmux has NO live free sessions (e.g. after
    // a tmux/server restart). The prune frees them; allocation succeeds at slot 1.
    for (let n = 1; n <= FREE_PROJECT_LIMIT; n++) setFreeProject(n, { label: null });
    const { deps } = makeDeps({ live: [] });
    const res = await createFreeProject(deps, "telegram:1", "fresh");
    expect(res).toEqual({ status: "created", sessionName: "tmux_proj_free_1", slot: 1 });
  });

  it("keeps a dead slot that still has a group binding", async () => {
    setFreeProject(5, { label: "bound" });
    bindGroup("oc_b", {
      workspacePath: "/work/app",
      sessionName: "tmux_proj_free_5",
      label: "app #2",
    });
    // free_5 is not live, but its group owns it → must NOT be pruned/reused.
    const { deps } = makeDeps({ live: [] });
    const res = await createFreeProject(deps, "telegram:1", "x");
    expect(res).toEqual({ status: "created", sessionName: "tmux_proj_free_1", slot: 1 });
    expect(getFreeProject(5)?.label).toBe("bound"); // still reserved
  });
});

describe("removeProjectBySession releases free slots", () => {
  it("frees the slot for a free session", async () => {
    setFreeProject(2, { label: "x" });
    const deps = {
      config: { projectSessionPrefix: "tmux_proj_" },
      claude: { checkIfRunning: vi.fn().mockResolvedValue(false) },
      queue: { clearSession: vi.fn() },
      bridge: { killSession: vi.fn().mockResolvedValue(undefined) },
      configResolver: { invalidate: vi.fn() },
      currentProject: { clearSession: vi.fn().mockResolvedValue(undefined) },
    } as never;
    await removeProjectBySession(deps, "tmux_proj_free_2");
    expect(getFreeProject(2)).toBeNull();
  });

  it("unbinds a group bound to the free session before recycling the slot", async () => {
    setFreeProject(3, { label: "g" });
    bindGroup("oc_g", {
      workspacePath: "/work/app",
      sessionName: "tmux_proj_free_3",
      label: "app #2",
    });
    const deps = {
      config: { projectSessionPrefix: "tmux_proj_" },
      claude: { checkIfRunning: vi.fn().mockResolvedValue(false) },
      queue: { clearSession: vi.fn() },
      bridge: { killSession: vi.fn().mockResolvedValue(undefined) },
      configResolver: { invalidate: vi.fn() },
      currentProject: { clearSession: vi.fn().mockResolvedValue(undefined) },
    } as never;
    await removeProjectBySession(deps, "tmux_proj_free_3");
    expect(getFreeProject(3)).toBeNull();
    // the dangling group binding must be gone, so reconcile can't resurrect the name
    expect(getBinding("oc_g")).toBeNull();
  });
});

describe("aliveProjectButtons includes path-less free sessions", () => {
  it("keeps a free session with no path mapping, labeled 🆓", async () => {
    setFreeProject(1, { label: "taskB" });
    const deps = {
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: { listProjectSessions: vi.fn().mockResolvedValue(["tmux_proj_free_1"]) },
      currentProject: { get: vi.fn().mockResolvedValue("tmux_proj_free_1") },
    } as never;
    const buttons = await aliveProjectButtons(deps, "telegram:1");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.label).toBe("🆓 taskB");
    expect(buttons[0]?.active).toBe(true);
  });
});
