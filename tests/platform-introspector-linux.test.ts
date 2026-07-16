import { describe, expect, it } from "vitest";
import { createLinuxIntrospector, type LinuxFs } from "../src/core/platform/introspector.linux.js";

const ENOENT = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

/** Build a fake /proc from plain JS maps. */
function fakeProc(opts: {
  pids: Record<
    number,
    { ppid: number; comm: string; cmdline: string; environ?: string; fds?: string[]; cwd?: string }
  >;
}): LinuxFs {
  const get = (pid: number) => opts.pids[pid];
  return {
    async readdir(path: string): Promise<string[]> {
      if (path === "/proc") return Object.keys(opts.pids);
      const m = path.match(/^\/proc\/(\d+)\/fd$/);
      if (m) {
        const p = get(Number(m[1]));
        if (!p?.fds) throw ENOENT;
        return p.fds.map((_, i) => String(i));
      }
      throw ENOENT;
    },
    async readFile(path: string): Promise<string> {
      const stat = path.match(/^\/proc\/(\d+)\/stat$/);
      if (stat) {
        const p = get(Number(stat[1]));
        if (!p) throw ENOENT;
        // pid (comm) state ppid ...  — comm may contain spaces/parens.
        return `${stat[1]} (${p.comm}) S ${p.ppid} 0 0 0`;
      }
      const cmd = path.match(/^\/proc\/(\d+)\/cmdline$/);
      if (cmd) {
        const p = get(Number(cmd[1]));
        if (!p) throw ENOENT;
        return p.cmdline; // already \0-separated by the test
      }
      const env = path.match(/^\/proc\/(\d+)\/environ$/);
      if (env) {
        const p = get(Number(env[1]));
        if (p?.environ == null) throw ENOENT;
        return p.environ;
      }
      throw ENOENT;
    },
    async readlink(path: string): Promise<string> {
      const fd = path.match(/^\/proc\/(\d+)\/fd\/(\d+)$/);
      if (fd) {
        const p = get(Number(fd[1]));
        const target = p?.fds?.[Number(fd[2])];
        if (target == null) throw ENOENT;
        return target;
      }
      const cwd = path.match(/^\/proc\/(\d+)\/cwd$/);
      if (cwd) {
        const p = get(Number(cwd[1]));
        if (p?.cwd == null) throw ENOENT;
        return p.cwd;
      }
      throw ENOENT;
    },
  };
}

describe("linux introspector", () => {
  it("snapshot reads ppid from stat and command from cmdline", async () => {
    const fs = fakeProc({
      pids: {
        100: { ppid: 1, comm: "zsh", cmdline: "-zsh\0" },
        200: { ppid: 100, comm: "claude", cmdline: "/home/u/.local/bin/claude\0--flag\0" },
      },
    });
    const rows = await createLinuxIntrospector(fs).snapshot();
    expect(rows).toEqual([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "/home/u/.local/bin/claude --flag" },
    ]);
  });

  it("snapshot skips kernel threads (empty cmdline) and vanished pids", async () => {
    const base = fakeProc({
      pids: {
        100: { ppid: 1, comm: "zsh", cmdline: "-zsh\0" },
        2: { ppid: 0, comm: "kthreadd", cmdline: "" }, // kernel thread
      },
    });
    // 999 appears in readdir but its files are gone (race).
    const fs: LinuxFs = {
      ...base,
      readdir: async (p) => (p === "/proc" ? ["100", "2", "999"] : base.readdir(p)),
    };
    const rows = await createLinuxIntrospector(fs).snapshot();
    expect(rows).toEqual([{ pid: 100, ppid: 1, command: "-zsh" }]);
  });

  it("snapshot parses ppid when comm contains spaces and parens", async () => {
    // /proc/<pid>/stat is `pid (comm) state ppid ...` and comm can hold spaces
    // and parens, e.g. `(Web Content)` or `(foo) bar` — ppid must come from the
    // field after the LAST ')'.
    const fs = fakeProc({
      pids: {
        200: { ppid: 100, comm: "Web Content) :)", cmdline: "/usr/bin/firefox\0" },
      },
    });
    const rows = await createLinuxIntrospector(fs).snapshot();
    expect(rows).toEqual([{ pid: 200, ppid: 100, command: "/usr/bin/firefox" }]);
  });

  it("readProcEnv normalises \\0 separators to newlines", async () => {
    const fs = fakeProc({
      pids: {
        200: {
          ppid: 1,
          comm: "claude",
          cmdline: "claude\0",
          environ: "PATH=/a:/b\0CLAUDE_CONFIG_DIR=/home/u/.claude-stella\0",
        },
      },
    });
    const env = await createLinuxIntrospector(fs).readProcEnv(200);
    expect(env).toBe("PATH=/a:/b\nCLAUDE_CONFIG_DIR=/home/u/.claude-stella\n");
  });

  it("readProcEnv returns '' when environ is unreadable", async () => {
    const fs = fakeProc({ pids: { 200: { ppid: 1, comm: "x", cmdline: "x\0" } } });
    expect(await createLinuxIntrospector(fs).readProcEnv(200)).toBe("");
  });

  it("listOpenFiles readlinks /proc/<pid>/fd, keeping only absolute paths", async () => {
    const fs = fakeProc({
      pids: {
        200: {
          ppid: 1,
          comm: "claude",
          cmdline: "claude\0",
          fds: ["/dev/null", "socket:[12345]", "/home/u/.claude/projects/foo/abc.jsonl"],
        },
      },
    });
    expect(await createLinuxIntrospector(fs).listOpenFiles(200)).toEqual([
      "/dev/null",
      "/home/u/.claude/projects/foo/abc.jsonl",
    ]);
  });

  it("ttyOf readlinks /proc/<pid>/fd/0 when it is a pts/tty device", async () => {
    const fs = fakeProc({
      pids: {
        200: {
          ppid: 1,
          comm: "claude",
          cmdline: "claude\0",
          fds: ["/dev/pts/0", "/home/u/.claude/projects/foo/abc.jsonl"],
        },
      },
    });
    expect(await createLinuxIntrospector(fs).ttyOf(200)).toBe("/dev/pts/0");
  });

  it("ttyOf returns null when fd 0 is not a terminal", async () => {
    const fs = fakeProc({
      pids: {
        200: {
          ppid: 1,
          comm: "claude",
          cmdline: "claude\0",
          fds: ["/dev/null"],
        },
      },
    });
    expect(await createLinuxIntrospector(fs).ttyOf(200)).toBeNull();
  });

  it("ttyOf returns null when the process has vanished", async () => {
    const fs = fakeProc({ pids: {} });
    expect(await createLinuxIntrospector(fs).ttyOf(999)).toBeNull();
  });

  it("cwdOf readlinks /proc/<pid>/cwd; null when absent", async () => {
    const fs = fakeProc({
      pids: { 200: { ppid: 1, comm: "x", cmdline: "x\0", cwd: "/home/u/project" } },
    });
    expect(await createLinuxIntrospector(fs).cwdOf(200)).toBe("/home/u/project");
    expect(await createLinuxIntrospector(fs).cwdOf(999)).toBeNull();
  });
});
