import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDir(prefix = "tcb-capabilities-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

describe("CLI capabilities command", () => {
  it("lists the default curated capability catalog", () => {
    const result = runCli(["capabilities", "list", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<{ id: string; type: string }>;
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "skill:mattpocock:improve-codebase-architecture",
          type: "skill",
        }),
      ]),
    );
  });

  it("reports task-specific missing recommended capabilities", () => {
    const result = runCli(["capabilities", "status", "--task", "architecture", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      taskKind: string;
      capabilities: Array<{ capabilityId: string; installed: boolean; blocking: boolean }>;
    };
    expect(parsed.taskKind).toBe("architecture");
    expect(parsed.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
          installed: false,
          blocking: false,
        }),
      ]),
    );
  });

  it("prints an install plan with approved skill metadata instead of direct third-party mutation", () => {
    const result = runCli(["capabilities", "install", "--default", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      approvedSkills: Array<{ id: string; ref: string }>;
      actions: Array<{ action: string; capabilityId: string }>;
    };
    expect(parsed.approvedSkills.map((skill) => skill.id)).toContain(
      "improve-codebase-architecture",
    );
    expect(parsed.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "install",
          capabilityId: "skill:mattpocock:improve-codebase-architecture",
        }),
      ]),
    );
  });

  it("prints the default capability update path", () => {
    const result = runCli(["capabilities", "update", "--default"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("capabilities update plan");
    expect(result.stdout).toContain("tcb loop skills refresh <file> --write");
  });
});
