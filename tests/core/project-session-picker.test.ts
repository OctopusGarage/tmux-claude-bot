import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseFreeSlot, setFreeProject } from "../../src/core/projects/free-projects.js";
import { bindGroup, unbindGroup } from "../../src/core/projects/group-bindings.js";
import {
  type ProjectPickerMode,
  projectPickerRows,
} from "../../src/core/projects/project-session-picker.js";
import { readRecentProjectLines } from "../../src/core/projects/recentProjects.js";
import {
  clearPathForSession,
  sessionNameFromPath,
  setPathForSession,
} from "../../src/core/projects/sessionPathMap.js";
import { sessionShortId } from "../../src/shared/utils/hash.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

vi.mock("../../src/core/projects/recentProjects.js", () => ({
  readRecentProjectLines: vi.fn(async () => []),
  appendRecentProject: vi.fn(async () => {}),
}));

async function mockRecents(paths: string[]): Promise<void> {
  vi.mocked(readRecentProjectLines).mockResolvedValue(paths);
}

describe("projectPickerRows", () => {
  let root: string;
  let regularPath: string;
  let groupedPath: string;
  let freePath: string;

  beforeEach(() => {
    vi.mocked(readRecentProjectLines).mockResolvedValue([]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-picker-"));
    regularPath = path.join(root, "regular");
    groupedPath = path.join(root, "grouped");
    freePath = path.join(root, "free");
    fs.mkdirSync(regularPath);
    fs.mkdirSync(groupedPath);
    fs.mkdirSync(freePath);
  });

  afterEach(() => {
    const prefix = fakeDeps().config.projectSessionPrefix;
    unbindGroup("oc_grouped");
    releaseFreeSlot(8);
    for (const session of [
      sessionNameFromPath(regularPath, prefix),
      sessionNameFromPath(groupedPath, prefix),
      "tmux_proj_free_8",
    ]) {
      clearPathForSession(session);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats stopped recent projects as recent entries, not project sessions", async () => {
    await mockRecents([regularPath]);
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });

    const rows = await projectPickerRows(deps, "telegram", "recent-projects");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryKind: "recent-project",
      alive: false,
      primaryAction: "create-session",
      actionIds: ["create-session"],
      path: regularPath,
    });
  });

  it("centralizes Lark project-group eligibility over regular ungrouped projects", async () => {
    const prefix = fakeDeps().config.projectSessionPrefix;
    const groupedSession = sessionNameFromPath(groupedPath, prefix);
    bindGroup("oc_grouped", {
      workspacePath: groupedPath,
      sessionName: groupedSession,
      label: "grouped",
    });
    await mockRecents([regularPath, groupedPath]);
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });

    const rows = await projectPickerRows(deps, "lark:chat", "project-group-create");

    expect(rows.map((r) => r.path)).toEqual([regularPath]);
    expect(rows[0]?.actionIds).toEqual(["create-project-group"]);
  });

  it("offers parallel groups for regular projects, including already grouped ones, but not free sessions", async () => {
    const prefix = fakeDeps().config.projectSessionPrefix;
    const groupedSession = sessionNameFromPath(groupedPath, prefix);
    const freeSession = "tmux_proj_free_8";
    bindGroup("oc_grouped", {
      workspacePath: groupedPath,
      sessionName: groupedSession,
      label: "grouped",
    });
    setPathForSession(freeSession, freePath);
    await mockRecents([regularPath, groupedPath]);
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [freeSession]) },
    });

    const rows = await projectPickerRows(deps, "lark:chat", "parallel-project-group");

    expect(rows.map((r) => r.sid).sort()).toEqual(
      [sessionShortId(sessionNameFromPath(regularPath, prefix)), sessionShortId(groupedSession)]
        .slice()
        .sort(),
    );
    expect(rows.some((r) => r.sessionName === freeSession)).toBe(false);
    expect(rows.every((r) => r.actionIds.includes("create-parallel-project-group"))).toBe(true);
  });

  it("keeps existing independent group creation available on live session rows", async () => {
    const freeSession = "tmux_proj_free_8";
    setPathForSession(freeSession, freePath);
    setFreeProject(8, { label: "worker" });
    const deps = fakeDeps({
      session: "other",
      bridge: { listProjectSessions: vi.fn(async () => [freeSession]) },
    });

    const rows = await projectPickerRows(deps, "lark:chat", "project-sessions");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionName: freeSession,
      primaryAction: "switch-session",
      canCreateFreeGroup: true,
    });
    expect(rows[0]?.actionIds).toEqual([
      "switch-session",
      "remove-session",
      "create-existing-independent-group",
    ]);
  });

  it("keeps supported picker modes explicit", () => {
    const modes: ProjectPickerMode[] = [
      "project-sessions",
      "recent-projects",
      "project-group-create",
      "project-group-bind",
      "parallel-project-group",
      "existing-independent-project-group",
    ];
    expect(modes).toHaveLength(6);
  });
});
