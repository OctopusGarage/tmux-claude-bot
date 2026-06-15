import { describe, expect, it } from "vitest";
import { createLinuxIntrospector, type LinuxFs } from "../src/core/platform/introspector.linux.js";

// Only meaningful on Linux (no /proc on macOS). Runs on the CI ubuntu leg;
// skipped on macOS dev machines.
// Platform-independent: drives the introspector with a fake /proc to exercise
// the malformed-stat guards in ppidFromStat (real /proc is always well-formed,
// so the real-/proc suite above never reaches these branches).
describe("linux introspector ppid parsing (fake /proc)", () => {
  const fakeFs = (files: Record<string, string>, dirs: string[]): LinuxFs => ({
    readdir: async (p) => (p === "/proc" ? dirs : []),
    readFile: async (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    readlink: async () => {
      throw new Error("unused");
    },
  });

  it("keeps well-formed rows and drops malformed /proc/<pid>/stat", async () => {
    const intro = createLinuxIntrospector(
      fakeFs(
        {
          "/proc/100/stat": "100 (zsh) S 1 100 100 0 -1", // valid → ppid 1
          "/proc/100/cmdline": "zsh\0",
          "/proc/200/stat": "malformed without a right paren", // rparen < 0 → null → dropped
          "/proc/200/cmdline": "claude\0",
          "/proc/300/stat": "300 (proc with ) spaces) S notanum 1", // NaN ppid → null → dropped
          "/proc/300/cmdline": "x\0",
          "/proc/400/stat": "400 (claude) S 100 400 400 0 -1", // comm with no special chars
          "/proc/400/cmdline": "claude\0--resume\0abc",
        },
        ["100", "200", "300", "400", "not-a-pid", "0"],
      ),
    );
    const rows = await intro.snapshot();
    expect(rows.map((r) => r.pid).sort((a, b) => a - b)).toEqual([100, 400]);
    expect(rows.find((r) => r.pid === 100)).toMatchObject({ ppid: 1, command: "zsh" });
    expect(rows.find((r) => r.pid === 400)).toMatchObject({
      ppid: 100,
      command: "claude --resume abc",
    });
  });
});

describe.skipIf(process.platform !== "linux")("linux introspector against real /proc", () => {
  const intro = createLinuxIntrospector();

  it("snapshot includes this process with the right ppid", async () => {
    const rows = await intro.snapshot();
    const self = rows.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.command.length).toBeGreaterThan(0);
  });

  it("readProcEnv exposes PATH from the launch environment", async () => {
    expect(await intro.readProcEnv(process.pid)).toContain("PATH=");
  });

  it("cwdOf returns this process's working directory", async () => {
    expect(await intro.cwdOf(process.pid)).toBe(process.cwd());
  });

  it("listOpenFiles returns absolute paths and tolerates a dead pid", async () => {
    const files = await intro.listOpenFiles(process.pid);
    expect(files.every((f) => f.startsWith("/"))).toBe(true);
    expect(await intro.listOpenFiles(2 ** 30)).toEqual([]); // unlikely-live pid
  });
});
