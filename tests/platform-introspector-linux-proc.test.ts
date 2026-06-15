import { describe, expect, it } from "vitest";
import { createLinuxIntrospector } from "../src/core/platform/introspector.linux.js";

// Only meaningful on Linux (no /proc on macOS). Runs on the CI ubuntu leg;
// skipped on macOS dev machines.
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
