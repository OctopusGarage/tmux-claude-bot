import { describe, expect, it, vi } from "vitest";
import { createDarwinIntrospector } from "../src/core/platform/introspector.darwin.js";

/** Fake execFileAsync: returns canned stdout keyed by the command name. */
function fakeExec(map: Record<string, string>) {
  return vi.fn(async (cmd: string) => {
    if (cmd in map) return { stdout: map[cmd], stderr: "" };
    throw new Error(`unexpected exec: ${cmd}`);
  });
}

describe("darwin introspector", () => {
  it("snapshot parses pid/ppid/command from `ps -axo`", async () => {
    const exec = fakeExec({
      ps: "  100     1 -zsh\n  200   100 /Users/x/.local/bin/claude --flag\n",
    });
    const intro = createDarwinIntrospector(exec as never);
    const rows = await intro.snapshot();
    expect(rows).toEqual([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "/Users/x/.local/bin/claude --flag" },
    ]);
  });

  it("readProcEnv returns the raw `ps eww` line", async () => {
    const exec = fakeExec({ ps: "claude CLAUDE_CONFIG_DIR=/Users/x/.claude-stella\n" });
    const intro = createDarwinIntrospector(exec as never);
    expect(await intro.readProcEnv(200)).toContain("CLAUDE_CONFIG_DIR=/Users/x/.claude-stella");
  });

  it("listOpenFiles returns every n-prefixed path from `lsof -Fn`", async () => {
    const exec = fakeExec({ lsof: "p200\nn/dev/null\nn/Users/x/.claude/projects/foo/abc.jsonl\n" });
    const intro = createDarwinIntrospector(exec as never);
    expect(await intro.listOpenFiles(200)).toEqual([
      "/dev/null",
      "/Users/x/.claude/projects/foo/abc.jsonl",
    ]);
  });

  it("cwdOf returns the n-line from `lsof -d cwd`", async () => {
    const exec = fakeExec({ lsof: "p200\nfcwd\nn/Users/x/project\n" });
    const intro = createDarwinIntrospector(exec as never);
    expect(await intro.cwdOf(200)).toBe("/Users/x/project");
  });

  it("ttyOf returns the stdin device from `lsof -d 0` when it is a terminal", async () => {
    const exec = fakeExec({ lsof: "p200\nf0\nn/dev/ttys001\n" });
    const intro = createDarwinIntrospector(exec as never);
    expect(await intro.ttyOf(200)).toBe("/dev/ttys001");
    expect(exec).toHaveBeenCalledWith("lsof", ["-a", "-p", "200", "-d", "0", "-Fn"], {
      timeout: 5000,
    });
  });

  it("ttyOf returns null when stdin is not a terminal", async () => {
    const exec = fakeExec({ lsof: "p200\nf0\nn/dev/null\n" });
    const intro = createDarwinIntrospector(exec as never);
    expect(await intro.ttyOf(200)).toBeNull();
  });

  it("returns safe empties when a command fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("boom");
    });
    const intro = createDarwinIntrospector(exec as never);
    expect(await intro.snapshot()).toEqual([]);
    expect(await intro.readProcEnv(1)).toBe("");
    expect(await intro.listOpenFiles(1)).toEqual([]);
    expect(await intro.cwdOf(1)).toBeNull();
    expect(await intro.ttyOf(1)).toBeNull();
  });
});
