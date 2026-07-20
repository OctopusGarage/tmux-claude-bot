import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/projects/recentProjects.js", () => ({
  readRecentProjectLines: vi.fn().mockResolvedValue(["/work/app"]),
  appendRecentProject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/adapters/lark/resource.js", () => ({
  createBoundChat: vi.fn().mockResolvedValue({ chatId: "oc_new", name: "app #2" }),
}));
vi.mock("../../src/adapters/lark/replies.js", () => ({ sendText: vi.fn(), sendCard: vi.fn() }));

import { makeFreeGroupBySid } from "../../src/adapters/lark/group-commands.js";
import { getFreeProject } from "../../src/core/projects/free-projects.js";
import { bindGroup, getBinding, listBindings } from "../../src/core/projects/group-bindings.js";
import { sessionShortId } from "../../src/shared/utils/hash.js";

let dir: string;
let orig: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-larkfree-"));
  orig = process.env.TCB_STATE_DIR;
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (orig === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = orig;
  vi.restoreAllMocks();
});

function deps() {
  return {
    config: { projectSessionPrefix: "tmux_proj_", lark: {} },
    bridge: {
      createSession: vi.fn().mockResolvedValue(true),
      listProjectSessions: vi.fn().mockResolvedValue([]),
    },
    currentProject: { set: vi.fn().mockResolvedValue(undefined) },
  } as never;
}

describe("makeFreeGroupBySid", () => {
  it("binds a new group to a fresh independent session on the same dir", async () => {
    bindGroup("oc_first", {
      workspacePath: "/work/app",
      sessionName: "tmux_proj_-work-app",
      label: "app",
    });
    const sid = sessionShortId("tmux_proj_-work-app");

    await makeFreeGroupBySid({} as never, deps(), "oc_origin", sid, "ou_me");

    const created = getBinding("oc_new");
    expect(created?.workspacePath).toBe("/work/app");
    expect(created?.sessionName).toBe("tmux_proj_free_1");
    expect(created?.label).toBe("app #2");
    expect(getFreeProject(1)?.label).toBe("app #2");
    expect(listBindings().filter((b) => b.binding.workspacePath === "/work/app")).toHaveLength(2);
  });
});
