import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseFreeSlot, setFreeProject } from "../../src/core/projects/free-projects.js";
import { bindGroup, unbindGroup } from "../../src/core/projects/group-bindings.js";
import { operatorSessionName } from "../../src/core/projects/operator.js";
import {
  catalogActionsForQuery,
  type ProjectSessionCatalogRow,
  readProjectSessionCatalog,
} from "../../src/core/projects/project-session-catalog.js";
import { readRecentProjectLines } from "../../src/core/projects/recentProjects.js";
import {
  clearPathForSession,
  sessionNameFromPath,
  setPathForSession,
} from "../../src/core/projects/sessionPathMap.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

vi.mock("../../src/core/projects/recentProjects.js", () => ({
  readRecentProjectLines: vi.fn(async () => []),
  appendRecentProject: vi.fn(async () => {}),
}));

async function mockRecents(paths: string[]): Promise<void> {
  vi.mocked(readRecentProjectLines).mockResolvedValue(paths);
}

function rowsOf(
  result: Awaited<ReturnType<typeof readProjectSessionCatalog>>,
): ProjectSessionCatalogRow[] {
  if (result.kind === "empty-current-selection") return [];
  return result.rows;
}

describe("readProjectSessionCatalog", () => {
  let root: string;
  let regularPath: string;
  let groupedPath: string;
  let liveOnlyPath: string;
  let independentPath: string;

  beforeEach(() => {
    vi.mocked(readRecentProjectLines).mockResolvedValue([]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-catalog-"));
    regularPath = path.join(root, "regular");
    groupedPath = path.join(root, "grouped");
    liveOnlyPath = path.join(root, "live-only");
    independentPath = path.join(root, "independent");
    for (const p of [regularPath, groupedPath, liveOnlyPath, independentPath]) {
      fs.mkdirSync(p);
    }
  });

  afterEach(() => {
    const prefix = fakeDeps().config.projectSessionPrefix;
    for (const chatId of ["oc_grouped", "oc_independent"]) unbindGroup(chatId);
    for (const session of [
      sessionNameFromPath(regularPath, prefix),
      sessionNameFromPath(groupedPath, prefix),
      sessionNameFromPath(liveOnlyPath, prefix),
      "tmux_proj_free_3",
      "tmux_proj_free_8",
      "tmux_proj_stopped_current",
    ]) {
      clearPathForSession(session);
    }
    releaseFreeSlot(3);
    releaseFreeSlot(8);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds workspace picker rows from recent workspaces plus live regular sessions", async () => {
    const deps = fakeDeps({
      session: null,
      bridge: {
        listProjectSessions: vi.fn(async () => [
          sessionNameFromPath(liveOnlyPath, fakeDeps().config.projectSessionPrefix),
        ]),
      },
    });
    const liveSession = sessionNameFromPath(liveOnlyPath, deps.config.projectSessionPrefix);
    setPathForSession(liveSession, liveOnlyPath);
    await mockRecents([regularPath]);

    const rows = rowsOf(
      await readProjectSessionCatalog(deps, { kind: "workspace-picker", scope: "telegram:1" }),
    );

    expect(rows.map((r) => r.workspace.path)).toEqual([regularPath, liveOnlyPath]);
    expect(rows.map((r) => r.entryKind)).toEqual(["recent-project", "project-session"]);
  });

  it("sorts the live roster with the current session first and excludes the operator", async () => {
    const prefix = fakeDeps().config.projectSessionPrefix;
    const a = sessionNameFromPath(regularPath, prefix);
    const b = sessionNameFromPath(groupedPath, prefix);
    const independent = "tmux_proj_free_3";
    setPathForSession(a, regularPath);
    setPathForSession(b, groupedPath);
    setPathForSession(independent, independentPath);
    setFreeProject(3, { label: "parallel" });
    const deps = fakeDeps({
      currentProject: { get: vi.fn(async () => b) },
      bridge: {
        listProjectSessions: vi.fn(async () => [independent, operatorSessionName(prefix), a, b]),
      },
    });

    const rows = rowsOf(
      await readProjectSessionCatalog(deps, { kind: "live-roster", scope: "telegram:1" }),
    );

    expect(rows.map((r) => r.sessionName)).toEqual([b, a, independent]);
    expect(rows.every((r) => r.kind !== "operator")).toBe(true);
  });

  it("keeps live-roster workspace validity rules in the catalog", async () => {
    const prefix = fakeDeps().config.projectSessionPrefix;
    const goneRegular = "tmux_proj_-gone";
    const independent = "tmux_proj_free_8";
    setPathForSession(goneRegular, path.join(root, "gone"));
    setFreeProject(8, { label: "scratch" });
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [goneRegular, independent]),
      },
      config: { projectSessionPrefix: prefix },
    });

    const rows = rowsOf(
      await readProjectSessionCatalog(deps, { kind: "live-roster", scope: "telegram:1" }),
    );

    expect(rows.map((r) => r.sessionName)).toEqual([independent]);
    expect(rows[0]).toMatchObject({
      kind: "independent",
      workspace: { path: null, exists: false },
    });
  });

  it("owns live-roster action selection, including secondary actions for the current row", async () => {
    const independent = "tmux_proj_free_8";
    setPathForSession(independent, independentPath);
    setFreeProject(8, { label: "worker" });
    const deps = fakeDeps({
      currentProject: { get: vi.fn(async () => independent) },
      bridge: { listProjectSessions: vi.fn(async () => [independent]) },
    });

    const [row] = rowsOf(
      await readProjectSessionCatalog(deps, { kind: "live-roster", scope: "lark:chat" }),
    );

    expect(row).toBeDefined();
    if (!row) throw new Error("expected an independent project row");
    expect(catalogActionsForQuery(row, { kind: "live-roster", scope: "lark:chat" })).toEqual({
      primaryAction: null,
      actionIds: ["remove-session", "bind-existing-independent-group"],
    });
  });

  it("blocks regular group creation for grouped projects but still allows parallel group sources", async () => {
    const prefix = fakeDeps().config.projectSessionPrefix;
    const groupedSession = sessionNameFromPath(groupedPath, prefix);
    bindGroup("oc_grouped", {
      workspacePath: groupedPath,
      sessionName: groupedSession,
      label: "grouped",
    });
    await mockRecents([regularPath, groupedPath]);
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });

    const createRows = rowsOf(
      await readProjectSessionCatalog(deps, {
        kind: "regular-group-candidates",
        scope: "lark:p2p",
      }),
    );
    const parallelRows = rowsOf(
      await readProjectSessionCatalog(deps, {
        kind: "parallel-group-sources",
        scope: "lark:p2p",
      }),
    );

    expect(createRows.map((r) => r.workspace.path)).toEqual([regularPath]);
    expect(parallelRows.map((r) => r.workspace.path)).toEqual([regularPath, groupedPath]);
    const groupedParallel = parallelRows.find((r) => r.sessionName === groupedSession);
    expect(groupedParallel?.actions["create-regular-group"]).toEqual({
      available: false,
      reason: "already-has-group",
    });
    expect(groupedParallel?.actions["create-parallel-group"]).toEqual({ available: true });
  });

  it("offers existing independent projects for group creation without using workspace-picker", async () => {
    const independent = "tmux_proj_free_8";
    setPathForSession(independent, independentPath);
    setFreeProject(8, { label: "worker" });
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [independent]) },
    });

    const workspaceRows = rowsOf(
      await readProjectSessionCatalog(deps, { kind: "workspace-picker", scope: "lark:p2p" }),
    );
    const independentRows = rowsOf(
      await readProjectSessionCatalog(deps, {
        kind: "existing-independent-group-candidates",
        scope: "lark:p2p",
      }),
    );

    expect(workspaceRows).toEqual([]);
    expect(independentRows).toHaveLength(1);
    expect(independentRows[0]).toMatchObject({
      sessionName: independent,
      kind: "independent",
      workspace: { path: independentPath, exists: true },
    });
    expect(independentRows[0]?.actions["bind-existing-independent-group"]).toEqual({
      available: true,
    });
  });

  it("returns a stopped current selection row with fallback agent facts", async () => {
    const current = "tmux_proj_stopped_current";
    setPathForSession(current, regularPath);
    const deps = fakeDeps({
      currentProject: { get: vi.fn(async () => current) },
      bridge: { listProjectSessions: vi.fn(async () => []) },
      configResolver: { detectAgentKind: vi.fn(async () => null) },
    });

    const rows = rowsOf(
      await readProjectSessionCatalog(deps, {
        kind: "current-selection",
        scope: "telegram:1",
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionName: current,
      entryKind: "current-selection",
      sessionLive: false,
      current: true,
      workspace: { path: regularPath, exists: true },
    });
  });
});
