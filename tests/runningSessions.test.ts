import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allRunningSessions,
  isSessionRunning,
  markSessionRunning,
  markSessionStopped,
  markSessionUsed,
  sessionLastUsedAt,
} from "../src/core/agents/runningSessions.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-running-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runningSessions", () => {
  it("is empty by default", () => {
    expect(isSessionRunning("nope")).toBe(false);
    expect(allRunningSessions()).toEqual([]);
  });

  it("marks running and stopped, and lists the running roster sorted", () => {
    markSessionRunning("tmux_proj_b");
    markSessionRunning("tmux_proj_a");
    expect(isSessionRunning("tmux_proj_a")).toBe(true);
    expect(allRunningSessions()).toEqual(["tmux_proj_a", "tmux_proj_b"]);

    markSessionStopped("tmux_proj_a");
    expect(isSessionRunning("tmux_proj_a")).toBe(false);
    expect(allRunningSessions()).toEqual(["tmux_proj_b"]);
  });

  it("tracks last meaningful session usage separately from the running roster", () => {
    expect(sessionLastUsedAt("tmux_proj_a")).toBeNull();

    markSessionRunning("tmux_proj_a", 1000);
    expect(sessionLastUsedAt("tmux_proj_a")).toBeNull();

    markSessionUsed("tmux_proj_a", 2000);
    expect(sessionLastUsedAt("tmux_proj_a")).toBe(2000);
  });
});
