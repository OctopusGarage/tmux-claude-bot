import type { spawnSync as spawnSyncType } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalPath = process.env.PATH;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe("system gate git execution", () => {
  it("rediscovers git when PATH becomes available after service startup", async () => {
    const spawnSync = vi.fn(
      (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === "/bin/sh" && args.join(" ") === "-lc command -v git") {
          const path = options?.env?.PATH ?? "";
          if (path.split(":").includes("/runtime/bin")) {
            return { status: 0, stdout: "/runtime/bin/git\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "" };
        }
        if (command === "/runtime/bin/git") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: new Error(`spawnSync ${command} ENOENT`),
        };
      },
    ) as unknown as typeof spawnSyncType;

    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawnSync };
    });
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (path: string) => path === "/runtime/bin/git",
      };
    });

    process.env.PATH = "";
    const { runGitCommand } = await import("../../src/core/loop/service.js");

    process.env.PATH = "/runtime/bin";
    const result = runGitCommand({ cwd: "/repo", args: ["status", "--porcelain"] });

    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(spawnSync).toHaveBeenLastCalledWith(
      "/runtime/bin/git",
      ["status", "--porcelain"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});
