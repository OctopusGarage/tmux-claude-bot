import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-cli-mcp-"));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], stateDir = tempDir()) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TCB_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

describe("CLI MCP command", () => {
  it("installs all MCP profile descriptors as JSON", () => {
    const stateDir = tempDir();
    const result = runCli(["mcp", "install", "--json"], stateDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const installed = JSON.parse(result.stdout) as Array<{ profile: string; path: string }>;
    expect(installed.map((item) => item.profile).sort()).toEqual(["home", "observer"]);
    expect(existsSync(join(stateDir, "home/mcp/observer.json"))).toBe(true);
    expect(existsSync(join(stateDir, "home/mcp/home.json"))).toBe(true);
  });

  it("installs one profile with an explicit stdio command", () => {
    const stateDir = tempDir();
    const result = runCli(
      ["mcp", "install", "--profile", "home", "--command", "/opt/tcb/bin/tcb", "--json"],
      stateDir,
    );

    expect(result.status).toBe(0);
    const installed = JSON.parse(result.stdout) as Array<{ profile: string }>;
    expect(installed).toEqual([
      {
        profile: "home",
        path: expect.any(String),
        command: "/opt/tcb/bin/tcb",
        args: ["mcp", "home"],
      },
    ]);
    const profile = JSON.parse(readFileSync(join(stateDir, "home/mcp/home.json"), "utf8"));
    expect(profile.server).toEqual({
      transport: "stdio",
      command: "/opt/tcb/bin/tcb",
      args: ["mcp", "home"],
    });
    expect(profile.tools).toContain("tcb.home.send_prompt");
  });

  it("rejects unknown MCP install profiles", () => {
    const result = runCli(["mcp", "install", "--profile", "worker"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown MCP profile "worker"');
  });
});
