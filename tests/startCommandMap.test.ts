import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearStartCommand,
  getStartCommand,
  setStartCommand,
} from "../src/core/agents/startCommandMap.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-startcmd-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("startCommandMap", () => {
  it("returns null for an unknown session", () => {
    expect(getStartCommand("nope")).toBeNull();
  });

  it("records and reads back the exact start command (flavor)", () => {
    setStartCommand("tmux_proj_x", "CLAUDE_CONFIG_DIR=~/.claude-stella claude --foo");
    expect(getStartCommand("tmux_proj_x")).toBe("CLAUDE_CONFIG_DIR=~/.claude-stella claude --foo");
  });

  it("clears a record (a reused free slot must not read a stale command)", () => {
    setStartCommand("tmux_proj_free_1", "codex");
    clearStartCommand("tmux_proj_free_1");
    expect(getStartCommand("tmux_proj_free_1")).toBeNull();
  });
});
