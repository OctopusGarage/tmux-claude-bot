import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appStateDir, appStateFile, stateDir } from "../src/shared/state-dir.js";

// The global test setup pins TCB_STATE_DIR to a temp dir; restore it after each
// test that mutates it so sibling tests keep their isolation.
const pinned = process.env.TCB_STATE_DIR;
afterEach(() => {
  if (pinned === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = pinned;
});

describe("stateDir (primitive)", () => {
  it("uses the fallback when TCB_STATE_DIR is unset", () => {
    delete process.env.TCB_STATE_DIR;
    expect(stateDir("/fallback")).toBe("/fallback");
  });

  it("honors TCB_STATE_DIR over the fallback", () => {
    process.env.TCB_STATE_DIR = "/override";
    expect(stateDir("/fallback")).toBe("/override");
  });
});

describe("appStateDir / appStateFile (single source of truth)", () => {
  it("uses TCB_STATE_DIR when set", () => {
    process.env.TCB_STATE_DIR = "/override";
    expect(appStateDir()).toBe("/override");
    expect(appStateFile("session_path_map.json")).toBe("/override/session_path_map.json");
  });

  it("falls back to the conventional ~/.tmux-claude-bot app home (never cwd or $HOME)", () => {
    delete process.env.TCB_STATE_DIR;
    expect(appStateDir()).toBe(join(homedir(), ".tmux-claude-bot"));
  });
});
