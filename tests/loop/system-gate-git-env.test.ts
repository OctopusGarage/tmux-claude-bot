import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (path: string) => path === "/usr/bin/git",
  };
});

describe("system gate git environment", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    vi.resetModules();
    spawnSyncMock.mockReset();
    process.env.PATH = "";
    spawnSyncMock.mockImplementation((command: string) => {
      if (command === "/bin/sh") {
        return { status: 0, stdout: "/usr/bin/git\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it("runs git with a service-safe PATH even when the launcher PATH is empty", async () => {
    const { runGitCommand } = await import("../../src/core/loop/service.js");

    const result = runGitCommand({ cwd: "/tmp/repo", args: ["status", "--porcelain"] });

    expect(result.status).toBe(0);
    expect(spawnSyncMock).toHaveBeenLastCalledWith(
      "/usr/bin/git",
      ["status", "--porcelain"],
      expect.objectContaining({
        cwd: "/tmp/repo",
        encoding: "utf8",
        env: expect.objectContaining({
          PATH: expect.stringContaining("/usr/bin"),
        }),
      }),
    );
  });
});
