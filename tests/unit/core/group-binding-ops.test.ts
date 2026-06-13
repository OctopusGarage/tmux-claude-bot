import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileGroupBinding,
  resolveWorkspaceTarget,
} from "../../../src/core/group-binding-ops.js";
import { bindGroup } from "../../../src/core/group-bindings.js";
import { setPathForSession } from "../../../src/core/sessionPathMap.js";
import { saveWorkspace } from "../../../src/core/workspaces.js";

function depsWith(cdAllowedDirs: string[]) {
  return {
    config: { cdAllowedDirs, projectSessionPrefix: "claude_" },
  } as unknown as Parameters<typeof resolveWorkspaceTarget>[0];
}

describe("resolveWorkspaceTarget", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-ws-"));
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
  });

  it("resolves an allow-listed absolute path to {path, sessionName, label}", async () => {
    const out = await resolveWorkspaceTarget(depsWith([dir]), dir);
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(out.workspacePath).toBe(dir);
      expect(out.sessionName).toBe(`claude_${dir.replace(/\//g, "-")}`);
      expect(out.label).toBe(dir.split("/").pop());
    }
  });

  it("rejects a path outside the cd allow-list", async () => {
    const out = await resolveWorkspaceTarget(depsWith(["/some/other/root"]), dir);
    expect(out).toEqual({ error: "not-allowed", resolvedPath: dir });
  });

  it("rejects a non-existent path", async () => {
    const out = await resolveWorkspaceTarget(depsWith([]), join(dir, "nope"));
    expect("error" in out && out.error).toBe("not-found");
  });

  it("resolves a saved workspace NAME to its session + path", async () => {
    saveWorkspace("myws", "sess-1");
    setPathForSession("sess-1", dir);
    const out = await resolveWorkspaceTarget(depsWith([]), "myws");
    expect(out).toEqual({ workspacePath: dir, sessionName: "sess-1", label: "myws" });
  });

  it("returns unknown-workspace when a saved name has no path mapping", async () => {
    saveWorkspace("ws2", "sess-no-path");
    const out = await resolveWorkspaceTarget(depsWith([]), "ws2");
    expect(out).toEqual({ error: "unknown-workspace" });
  });
});

function reconcileDeps(opts: { hasSession: boolean; pointer: string | null }) {
  const set = vi.fn(async () => {});
  return {
    deps: {
      config: { sessionWarmupMs: 0, projectSessionPrefix: "claude_" },
      bridge: {
        hasSession: vi.fn(async () => opts.hasSession),
        createSession: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      currentProject: { get: vi.fn(async () => opts.pointer), set },
    } as unknown as Parameters<typeof reconcileGroupBinding>[0],
    set,
  };
}

describe("reconcileGroupBinding", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-rec-"));
    process.env.TCB_STATE_DIR = dir;
    bindGroup("oc_g", { workspacePath: dir, sessionName: "claude_s", label: "p" });
    setPathForSession("claude_s", dir);
  });
  afterEach(() => delete process.env.TCB_STATE_DIR);

  it("status=ok when pointer already matches a live session", async () => {
    const { deps, set } = reconcileDeps({ hasSession: true, pointer: "claude_s" });
    const r = await reconcileGroupBinding(deps, "lark", "oc_g");
    expect(r).toMatchObject({ status: "ok", sessionName: "claude_s" });
    expect(set).not.toHaveBeenCalled();
  });

  it("status=restored when the pointer drifted but the session is alive", async () => {
    const { deps, set } = reconcileDeps({ hasSession: true, pointer: "claude_other" });
    const r = await reconcileGroupBinding(deps, "lark", "oc_g");
    expect(r).toMatchObject({ status: "restored", sessionName: "claude_s", label: "p" });
    expect(set).toHaveBeenCalledWith("lark:oc_g", "claude_s");
  });

  it("status=restored and recreates the session when it is gone", async () => {
    const { deps } = reconcileDeps({ hasSession: false, pointer: null });
    const r = await reconcileGroupBinding(deps, "lark", "oc_g");
    expect(r).toMatchObject({ status: "restored" });
    // The pane is recreated directly in the bound workspace dir (-c), no typed cd.
    expect(deps.bridge.createSession).toHaveBeenCalledWith("claude_s", expect.any(String));
  });

  it("status=missing-path when the bound directory no longer exists", async () => {
    bindGroup("oc_g", { workspacePath: join(dir, "gone"), sessionName: "claude_s", label: "p" });
    const { deps } = reconcileDeps({ hasSession: true, pointer: "claude_s" });
    const r = await reconcileGroupBinding(deps, "lark", "oc_g");
    expect(r).toMatchObject({ status: "missing-path", label: "p" });
  });
});
