import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  saveWorkspace,
  WORKSPACE_NAME_RE,
} from "../src/core/workspaces.js";

let stateDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-ws-"));
  origEnv = process.env.TCB_STATE_DIR;
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (origEnv === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = origEnv;
});

describe("workspaces", () => {
  it("getWorkspace returns null when nothing is saved", () => {
    expect(getWorkspace("missing")).toBeNull();
  });

  it("saveWorkspace then getWorkspace returns the session", () => {
    saveWorkspace("my-proj", "tmux_proj_foo");
    expect(getWorkspace("my-proj")).toBe("tmux_proj_foo");
  });

  it("saveWorkspace overwrites an existing name", () => {
    saveWorkspace("x", "session-a");
    saveWorkspace("x", "session-b");
    expect(getWorkspace("x")).toBe("session-b");
  });

  it("listWorkspaces returns empty array when none saved", () => {
    expect(listWorkspaces()).toEqual([]);
  });

  it("listWorkspaces returns all saved workspaces sorted by name", () => {
    saveWorkspace("beta", "sess-b");
    saveWorkspace("alpha", "sess-a");
    expect(listWorkspaces()).toEqual([
      { name: "alpha", session: "sess-a" },
      { name: "beta", session: "sess-b" },
    ]);
  });

  it("removeWorkspace returns true and deletes the entry", () => {
    saveWorkspace("del-me", "sess");
    expect(removeWorkspace("del-me")).toBe(true);
    expect(getWorkspace("del-me")).toBeNull();
  });

  it("removeWorkspace returns false when name does not exist", () => {
    expect(removeWorkspace("ghost")).toBe(false);
  });

  it("WORKSPACE_NAME_RE accepts valid names", () => {
    for (const valid of ["a", "abc-123", "my_proj", "A1-b_2", "x".repeat(32)]) {
      expect(WORKSPACE_NAME_RE.test(valid)).toBe(true);
    }
  });

  it("WORKSPACE_NAME_RE rejects invalid names", () => {
    for (const bad of ["", "has space", "dot.name", "x".repeat(33), "slash/name"]) {
      expect(WORKSPACE_NAME_RE.test(bad)).toBe(false);
    }
  });
});
