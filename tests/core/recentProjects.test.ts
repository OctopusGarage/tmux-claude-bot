import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const stateDir = process.env.TCB_STATE_DIR!;
const file = path.join(stateDir, "recent_projects.txt");

afterEach(() => {
  vi.resetModules();
  if (fs.existsSync(file)) fs.rmSync(file);
});

describe("readRecentProjectLines", () => {
  it("reads from file on first call (cache miss)", async () => {
    fs.writeFileSync(file, "/proj/a\n/proj/b\n", "utf-8");
    const { readRecentProjectLines } = await import("../../src/core/recentProjects.js");
    const lines = await readRecentProjectLines();
    expect(lines).toEqual(["/proj/a", "/proj/b"]);
  });

  it("returns cached result on second call without re-reading the file", async () => {
    fs.writeFileSync(file, "/proj/c\n", "utf-8");
    const { readRecentProjectLines } = await import("../../src/core/recentProjects.js");
    await readRecentProjectLines();
    fs.rmSync(file);
    const lines = await readRecentProjectLines();
    expect(lines).toEqual(["/proj/c"]);
  });

  it("returns empty array when file does not exist", async () => {
    const { readRecentProjectLines } = await import("../../src/core/recentProjects.js");
    const lines = await readRecentProjectLines();
    expect(lines).toEqual([]);
  });
});

describe("appendRecentProject", () => {
  it("trims the list to 15 entries when it overflows", async () => {
    const { appendRecentProject, readRecentProjectLines } = await import(
      "../../src/core/recentProjects.js"
    );
    for (let i = 0; i < 16; i++) {
      await appendRecentProject(`/proj/${i}`, "pfx_");
    }
    const lines = await readRecentProjectLines();
    expect(lines.length).toBe(15);
  });

  it("deduplicates by path — same path stays once", async () => {
    const { appendRecentProject, readRecentProjectLines } = await import(
      "../../src/core/recentProjects.js"
    );
    await appendRecentProject("/proj/a", "pfx_");
    await appendRecentProject("/proj/b", "pfx_");
    await appendRecentProject("/proj/a", "pfx_");
    const lines = await readRecentProjectLines();
    expect(lines.filter((l) => l === "/proj/a").length).toBe(1);
  });
});
